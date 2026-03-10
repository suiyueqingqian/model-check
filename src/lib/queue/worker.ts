// BullMQ Worker for processing detection jobs

import { Worker, Job } from "bullmq";
import { getRedisClient } from "@/lib/redis";
import prisma from "@/lib/prisma";
import { executeDetection, sleep, randomDelay } from "@/lib/detection/detector";
import type { DetectionJobData, DetectionResult } from "@/lib/detection/types";
import { DETECTION_QUEUE_NAME, PROGRESS_CHANNEL } from "./constants";

// Worker configuration (from environment variables)
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "0", 10);
const SEMAPHORE_POLL_MS = 500; // Poll interval when waiting for slot
const SEMAPHORE_TTL = 660; // TTL in seconds for semaphore keys (should > PROXY_TIMEOUT 600s)
const CONFIG_CACHE_TTL_MS = 5000;

function getRedis() {
  return getRedisClient();
}

interface WorkerRuntimeConfig {
  channelConcurrency: number;
  maxGlobalConcurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  channelConcurrency: parseInt(process.env.CHANNEL_CONCURRENCY || "5", 10),
  maxGlobalConcurrency: parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "30", 10),
  minDelayMs: parseInt(process.env.DETECTION_MIN_DELAY_MS || "3000", 10),
  maxDelayMs: parseInt(process.env.DETECTION_MAX_DELAY_MS || "5000", 10),
};

let cachedConfig: WorkerRuntimeConfig | null = null;
let cachedAt = 0;
let loadingConfigPromise: Promise<WorkerRuntimeConfig> | null = null;
const activeDetectionControllers = new Map<string, Set<AbortController>>();

// Redis keys
const GLOBAL_SEMAPHORE_KEY = "detection:semaphore:global";

// Worker instance
let worker: Worker<DetectionJobData, DetectionResult> | null = null;

function registerActiveDetectionController(modelId: string, controller: AbortController): void {
  const controllers = activeDetectionControllers.get(modelId);
  if (controllers) {
    controllers.add(controller);
    return;
  }
  activeDetectionControllers.set(modelId, new Set([controller]));
}

function unregisterActiveDetectionController(modelId: string, controller: AbortController): void {
  const controllers = activeDetectionControllers.get(modelId);
  if (!controllers) {
    return;
  }
  controllers.delete(controller);
  if (controllers.size === 0) {
    activeDetectionControllers.delete(modelId);
  }
}

export function cancelActiveDetectionsByModelIds(modelIds: string[]): number {
  let cancelled = 0;

  for (const modelId of modelIds) {
    const controllers = activeDetectionControllers.get(modelId);
    if (!controllers) {
      continue;
    }

    for (const controller of controllers) {
      if (controller.signal.aborted) {
        continue;
      }
      controller.abort("cancelled-by-user");
      cancelled += 1;
    }
  }

  return cancelled;
}

function getEffectiveWorkerConcurrency(config: WorkerRuntimeConfig): number {
  const requestedConcurrency = config.maxGlobalConcurrency * config.channelConcurrency;
  if (WORKER_CONCURRENCY > 0) {
    return Math.max(1, Math.min(WORKER_CONCURRENCY, requestedConcurrency));
  }
  return Math.max(1, requestedConcurrency);
}

function applyWorkerConcurrency(config: WorkerRuntimeConfig): void {
  if (!worker) {
    return;
  }

  const nextConcurrency = getEffectiveWorkerConcurrency(config);
  if (worker.concurrency !== nextConcurrency) {
    worker.concurrency = nextConcurrency;
  }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed >= 0 ? parsed : fallback;
}

function normalizeConfig(config: Partial<WorkerRuntimeConfig>): WorkerRuntimeConfig {
  const minDelayMs = parseNonNegativeInt(config.minDelayMs, DEFAULT_WORKER_CONFIG.minDelayMs);
  const maxDelayMsRaw = parseNonNegativeInt(config.maxDelayMs, DEFAULT_WORKER_CONFIG.maxDelayMs);
  const maxDelayMs = Math.max(maxDelayMsRaw, minDelayMs);

  return {
    channelConcurrency: parsePositiveInt(config.channelConcurrency, DEFAULT_WORKER_CONFIG.channelConcurrency),
    maxGlobalConcurrency: parsePositiveInt(config.maxGlobalConcurrency, DEFAULT_WORKER_CONFIG.maxGlobalConcurrency),
    minDelayMs,
    maxDelayMs,
  };
}

export async function loadWorkerConfig(): Promise<WorkerRuntimeConfig> {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (!loadingConfigPromise) {
    loadingConfigPromise = (async () => {
      try {
        const dbConfig = await prisma.schedulerConfig.findUnique({
          where: { id: "default" },
          select: {
            channelConcurrency: true,
            maxGlobalConcurrency: true,
            minDelayMs: true,
            maxDelayMs: true,
          },
        });

        const resolvedConfig = dbConfig
          ? normalizeConfig(dbConfig)
          : normalizeConfig(DEFAULT_WORKER_CONFIG);

        cachedConfig = resolvedConfig;
        cachedAt = Date.now();
        applyWorkerConcurrency(resolvedConfig);
        return resolvedConfig;
      } catch {
        const fallbackConfig = cachedConfig ?? normalizeConfig(DEFAULT_WORKER_CONFIG);
        cachedConfig = fallbackConfig;
        cachedAt = Date.now();
        applyWorkerConcurrency(fallbackConfig);
        return fallbackConfig;
      } finally {
        loadingConfigPromise = null;
      }
    })();
  }

  return loadingConfigPromise;
}

export function reloadWorkerConfig(): void {
  cachedConfig = null;
  cachedAt = 0;
}

/**
 * Redis-based semaphore for concurrency control
 */
function channelSemaphoreKey(channelId: string): string {
  return `detection:semaphore:channel:${channelId}`;
}

// Lua 脚本：原子 incr + expire（仅首次创建时设置 TTL，防止反复刷新）
const ACQUIRE_SLOT_LUA = `
local current = redis.call('incr', KEYS[1])
if current == 1 then
  redis.call('expire', KEYS[1], ARGV[1])
end
return current
`;

async function acquireSlots(channelId: string, config: WorkerRuntimeConfig): Promise<void> {
  const channelKey = channelSemaphoreKey(channelId);
  const MAX_WAIT_ATTEMPTS = 240; // 240 × 500ms = 120s
  const maxJobConcurrency = getEffectiveWorkerConcurrency(config);
  let attempts = 0;

  // Must acquire both global and channel slots
  while (true) {
    if (++attempts > MAX_WAIT_ATTEMPTS) {
      throw new Error(`acquireSlots timeout after ${MAX_WAIT_ATTEMPTS * SEMAPHORE_POLL_MS}ms`);
    }
    // Atomic incr + expire for global slot
    const globalCount = await getRedis().eval(ACQUIRE_SLOT_LUA, 1, GLOBAL_SEMAPHORE_KEY, SEMAPHORE_TTL) as number;
    if (globalCount > maxJobConcurrency) {
      await getRedis().decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }

    // Atomic incr + expire for channel slot
    const channelCount = await getRedis().eval(ACQUIRE_SLOT_LUA, 1, channelKey, SEMAPHORE_TTL) as number;
    if (channelCount > config.channelConcurrency) {
      // Release channel slot and global slot, then wait
      await getRedis().decr(channelKey);
      await getRedis().decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }

    // Got both slots
    return;
  }
}

async function releaseSlots(channelId: string): Promise<void> {
  const channelKey = channelSemaphoreKey(channelId);

  // Release both slots with minimum value protection
  // Use pipeline for atomic execution
  const pipeline = getRedis().pipeline();
  pipeline.decr(channelKey);
  pipeline.decr(GLOBAL_SEMAPHORE_KEY);
  const results = await pipeline.exec();

  // Check results and ensure counters don't go negative
  const channelVal = (results?.[0]?.[1] as number) ?? 0;
  const globalVal = (results?.[1]?.[1] as number) ?? 0;

  // Clean up or reset if counters are at or below 0
  // This prevents negative values from accumulating if queue was forcibly cleared
  if (channelVal <= 0) {
    await getRedis().del(channelKey);
  }
  if (globalVal <= 0) {
    await getRedis().del(GLOBAL_SEMAPHORE_KEY);
  }
}

async function clearSemaphoreKeys(): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await getRedis().scan(cursor, "MATCH", "detection:semaphore:*", "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length > 0) {
    await getRedis().del(...keys);
  }
}

/**
 * Process a single detection job
 */
async function processDetectionJob(
  job: Job<DetectionJobData, DetectionResult>
): Promise<DetectionResult> {
  const { data } = job;
  const runtimeConfig = await loadWorkerConfig();
  const queueState = await import("./queue");

  const finishCancelledBeforeExecution = async (errorMsg: string): Promise<DetectionResult> => {
    await queueState.decrementModelRemaining(data.modelId);
    await queueState.onDetectionJobSettled(
      data,
      runtimeConfig.channelConcurrency,
      await queueState.isDetectionStopped()
    );
    return {
      status: "FAIL",
      latency: 0,
      endpointType: data.endpointType,
      errorMsg,
    };
  };

  // Check if detection has been stopped before processing
  const stoppedBeforeStart = await queueState.isDetectionStopped();
  if (stoppedBeforeStart) {
    return finishCancelledBeforeExecution("Detection stopped by user");
  }

  // Acquire concurrency slots (both global and per-channel)
  // 信号量获取放在 try 内部，用标志位确保只在成功获取后才释放
  let slotsAcquired = false;

  try {
    await acquireSlots(data.channelId, runtimeConfig);
    slotsAcquired = true;
    // Check again after acquiring slot (in case stop was triggered during wait)
    const stoppedAfterAcquire = await queueState.isDetectionStopped();
    if (stoppedAfterAcquire) {
      return finishCancelledBeforeExecution("Detection stopped by user");
    }

    if (await queueState.isModelCancelled(data.modelId)) {
      return finishCancelledBeforeExecution("Model detection cancelled by user");
    }

    // Anti-blocking delay (3-5 seconds random)
    const delay = randomDelay(runtimeConfig.minDelayMs, runtimeConfig.maxDelayMs);
    await sleep(delay);

    if (await queueState.isModelCancelled(data.modelId)) {
      return finishCancelledBeforeExecution("Model detection cancelled by user");
    }

    // Execute the actual detection
    const detectionController = new AbortController();
    registerActiveDetectionController(data.modelId, detectionController);
    const result = await executeDetection(data, { signal: detectionController.signal })
      .finally(() => {
        unregisterActiveDetectionController(data.modelId, detectionController);
      });

    // Check if this model was selectively cancelled while job was active
    const modelCancelled = await queueState.isModelCancelled(data.modelId);

    if (!modelCancelled) {
      // Use atomic operations to avoid race conditions when updating detectedEndpoints
      // Multiple detection jobs for the same model can run in parallel
      await prisma.$transaction(async (tx) => {
        if (result.status === "SUCCESS") {
          // Atomically add endpoint to array if not already present (PostgreSQL array operation)
          // Use result.endpointType (may differ from job's when CHAT falls back to CODEX)
          await tx.$executeRaw`
            UPDATE "models"
            SET "detected_endpoints" =
              CASE
                WHEN ${result.endpointType} = ANY("detected_endpoints") THEN "detected_endpoints"
                ELSE COALESCE("detected_endpoints", ARRAY[]::text[]) || ARRAY[${result.endpointType}]
              END,
              "last_status" = true,
              "last_latency" = ${result.latency},
              "last_checked_at" = ${new Date()}
            WHERE id = ${data.modelId}
          `;
        } else {
          // Atomically remove endpoint from array (PostgreSQL array_remove)
          await tx.$executeRaw`
            UPDATE "models"
            SET "detected_endpoints" = array_remove(COALESCE("detected_endpoints", ARRAY[]::text[]), ${result.endpointType}),
              "last_status" = COALESCE(array_length(array_remove(COALESCE("detected_endpoints", ARRAY[]::text[]), ${result.endpointType}), 1), 0) > 0,
              "last_latency" = NULL,
              "last_checked_at" = ${new Date()}
            WHERE id = ${data.modelId}
          `;
        }

        // Create check log entry
        await tx.checkLog.create({
          data: {
            modelId: data.modelId,
            endpointType: result.endpointType,
            status: result.status,
            latency: result.latency,
            statusCode: result.statusCode,
            errorMsg: result.errorMsg,
            responseContent: result.responseContent,
          },
        });

      });
    }

    // 统一在一个地方递减 remaining 计数器，避免取消路径和正常路径重复递减
    const isModelComplete = await queueState.decrementModelRemaining(data.modelId);
    if (modelCancelled && isModelComplete) {
      await queueState.clearModelCancelled(data.modelId);
    }
    await queueState.onDetectionJobSettled(
      data,
      runtimeConfig.channelConcurrency,
      await queueState.isDetectionStopped()
    );

    // Publish progress update for SSE (with error handling to not affect detection result)
    const progressData = {
      channelId: data.channelId,
      modelId: data.modelId,
      modelName: data.modelName,
      endpointType: data.endpointType,
      status: modelCancelled ? "FAIL" : result.status,
      latency: modelCancelled ? 0 : result.latency,
      timestamp: Date.now(),
      isModelComplete, // true when all endpoints for this model are done
    };

    try {
      await getRedis().publish(PROGRESS_CHANNEL, JSON.stringify(progressData));
    } catch {
      // Redis publish failure should not affect the detection result
    }

    if (modelCancelled) {
      return {
        status: "FAIL",
        latency: 0,
        endpointType: data.endpointType,
        errorMsg: "Model detection cancelled by user",
      };
    }

    return result;
  } finally {
    // 只在成功获取信号量后才释放，避免多余的 decr
    if (slotsAcquired) {
      await releaseSlots(data.channelId);
    }
  }
}

/**
 * Start the detection worker
 */
export function startWorker(): Worker<DetectionJobData, DetectionResult> {
  if (worker) {
    return worker;
  }

  void clearSemaphoreKeys().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Worker] 清理旧信号量失败:", message);
  });

  worker = new Worker<DetectionJobData, DetectionResult>(
      DETECTION_QUEUE_NAME,
      processDetectionJob,
    {
      connection: getRedis().duplicate(),
      concurrency: getEffectiveWorkerConcurrency(DEFAULT_WORKER_CONFIG),
    }
  );

  void loadWorkerConfig().catch(() => {
  });

  // Event handlers
  worker.on("completed", () => {
  });

  worker.on("failed", async (job, err) => {
    const jobInfo = job?.data
      ? `channel=${job.data.channelId} model=${job.data.modelName} endpoint=${job.data.endpointType}`
      : "job=unknown";
    console.error("[Worker] Job failed:", jobInfo, err.message);

    if (!job?.data) {
      return;
    }

    const maxAttempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      const runtimeConfig = await loadWorkerConfig();
      const { decrementModelRemaining, isDetectionStopped, onDetectionJobSettled } = await import("./queue");
      await decrementModelRemaining(job.data.modelId);
      await onDetectionJobSettled(
        job.data,
        runtimeConfig.channelConcurrency,
        await isDetectionStopped()
      );
    } catch (settleError) {
      const settleMessage = settleError instanceof Error ? settleError.message : String(settleError);
      console.error("[Worker] 最终失败后的补位处理失败:", settleMessage);
    }
  });

  worker.on("error", (err) => {
    console.error("[Worker] Error:", err.message);
  });

  worker.on("stalled", (jobId) => {
    console.error(`[Worker] Job ${jobId} stalled`);
  });

  return worker;
}

/**
 * Stop the detection worker
 */
export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

/**
 * Get worker status
 */
export function isWorkerRunning(): boolean {
  return worker !== null && !worker.closing;
}
