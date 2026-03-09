// BullMQ Queue Configuration for Detection Jobs

import { randomUUID } from "crypto";
import { Queue } from "bullmq";
import redis from "@/lib/redis";
import type { DetectionJobData } from "@/lib/detection/types";
import { createAsyncErrorHandler, logWarn } from "@/lib/utils/error";
import { DETECTION_QUEUE_NAME, DETECTION_STOPPED_KEY, DETECTION_STOPPED_TTL, CANCELLED_MODELS_KEY, CANCELLED_MODELS_TTL, PROGRESS_BASELINE_KEY } from "./constants";

const MODEL_REMAINING_PREFIX = "detection:model_remaining:";
const DETECTION_SESSION_PREFIX = "detection:session:";
const DETECTION_SESSION_TTL = 7200;
const DETECTION_SESSION_LOCK_RETRY = 40;
const DETECTION_SESSION_LOCK_WAIT_MS = 50;

// Queue instance (singleton)
let detectionQueue: Queue<DetectionJobData> | null = null;

type SessionChannelJobs = {
  channelId: string;
  jobs: DetectionJobData[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSessionBaseKey(sessionId: string): string {
  return `${DETECTION_SESSION_PREFIX}${sessionId}`;
}

function getSessionPendingChannelsKey(sessionId: string): string {
  return `${getSessionBaseKey(sessionId)}:pending_channels`;
}

function getSessionActiveChannelsKey(sessionId: string): string {
  return `${getSessionBaseKey(sessionId)}:active_channels`;
}

function getSessionChannelJobsKey(sessionId: string, channelId: string): string {
  return `${getSessionBaseKey(sessionId)}:channel:${channelId}:jobs`;
}

function getSessionChannelInflightKey(sessionId: string, channelId: string): string {
  return `${getSessionBaseKey(sessionId)}:channel:${channelId}:inflight`;
}

function getSessionChannelLockKey(sessionId: string, channelId: string): string {
  return `${getSessionBaseKey(sessionId)}:channel:${channelId}:lock`;
}

function serializeDetectionJob(job: DetectionJobData): string {
  return JSON.stringify(job);
}

function parseDetectionJob(raw: string | null): DetectionJobData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DetectionJobData;
  } catch {
    return null;
  }
}

async function withChannelSessionLock<T>(
  sessionId: string,
  channelId: string,
  task: () => Promise<T>
): Promise<T> {
  const lockKey = getSessionChannelLockKey(sessionId, channelId);

  for (let i = 0; i < DETECTION_SESSION_LOCK_RETRY; i += 1) {
    const acquired = await redis.set(lockKey, "1", "EX", 10, "NX");
    if (acquired === "OK") {
      try {
        return await task();
      } finally {
        await redis.del(lockKey);
      }
    }
    await sleep(DETECTION_SESSION_LOCK_WAIT_MS);
  }

  throw new Error(`获取检测会话锁超时: ${channelId}`);
}

async function applyModelRemainingCounts(jobs: DetectionJobData[]): Promise<void> {
  const modelJobCounts = new Map<string, number>();
  for (const data of jobs) {
    modelJobCounts.set(data.modelId, (modelJobCounts.get(data.modelId) || 0) + 1);
  }
  if (modelJobCounts.size === 0) {
    return;
  }

  const pipeline = redis.pipeline();
  for (const [modelId, count] of modelJobCounts) {
    const key = `${MODEL_REMAINING_PREFIX}${modelId}`;
    pipeline.incrby(key, count);
    pipeline.expire(key, 3600);
  }
  await pipeline.exec();
}

async function enqueueSessionChannelJobs(
  sessionId: string,
  channelId: string,
  limit: number
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }

  const jobsKey = getSessionChannelJobsKey(sessionId, channelId);
  const inflightKey = getSessionChannelInflightKey(sessionId, channelId);
  const jobs: DetectionJobData[] = [];

  for (let i = 0; i < limit; i += 1) {
    const job = parseDetectionJob(await redis.lpop(jobsKey));
    if (!job) {
      break;
    }
    jobs.push(job);
  }

  if (jobs.length === 0) {
    return [];
  }

  const jobIds = await addDetectionJobsBulk(jobs, { trackRemaining: false });
  const pipeline = redis.pipeline();
  pipeline.incrby(inflightKey, jobs.length);
  pipeline.expire(inflightKey, DETECTION_SESSION_TTL);
  pipeline.expire(jobsKey, DETECTION_SESSION_TTL);
  pipeline.expire(getSessionActiveChannelsKey(sessionId), DETECTION_SESSION_TTL);
  pipeline.expire(getSessionPendingChannelsKey(sessionId), DETECTION_SESSION_TTL);
  await pipeline.exec();

  return jobIds;
}

async function cleanupDetectionSessionIfIdle(sessionId: string): Promise<void> {
  const [activeCount, pendingCount] = await Promise.all([
    redis.scard(getSessionActiveChannelsKey(sessionId)),
    redis.llen(getSessionPendingChannelsKey(sessionId)),
  ]);

  if (activeCount > 0 || pendingCount > 0) {
    return;
  }

  const keys = await scanKeys(`${getSessionBaseKey(sessionId)}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Get or create the detection queue instance
 */
export function getDetectionQueue(): Queue<DetectionJobData> {
  if (!detectionQueue) {
    detectionQueue = new Queue<DetectionJobData>(DETECTION_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000, // Start with 5 second delay, exponential backoff
        },
        removeOnComplete: {
          count: 1000, // Keep last 1000 completed jobs
          age: 3600,   // Remove completed jobs older than 1 hour
        },
        removeOnFail: {
          count: 500,  // Keep last 500 failed jobs for debugging
          age: 86400,  // Remove failed jobs older than 24 hours
        },
      },
    });
  }
  return detectionQueue;
}

/**
 * Add a single detection job to the queue
 */
export async function addDetectionJob(data: DetectionJobData): Promise<string> {
  const queue = getDetectionQueue();
  const job = await queue.add(`detect-${data.modelName}`, data, {
    // Include endpointType in jobId to ensure uniqueness when testing multiple endpoints
    jobId: `${data.channelId}-${data.modelId}-${data.endpointType}-${Date.now()}`,
  });
  return job.id || "";
}

/**
 * Add multiple detection jobs in bulk
 */
export async function addDetectionJobsBulk(
  jobs: DetectionJobData[],
  options?: { trackRemaining?: boolean }
): Promise<string[]> {
  const queue = getDetectionQueue();
  const timestamp = Date.now();
  const bulkJobs = jobs.map((data, index) => ({
    name: `detect-${data.modelName}`,
    data,
    opts: {
      // Include endpointType and index to ensure unique jobId for each job
      jobId: `${data.channelId}-${data.modelId}-${data.endpointType}-${timestamp}-${index}`,
    },
  }));

  const addedJobs = await queue.addBulk(bulkJobs);

  if (options?.trackRemaining !== false) {
    await applyModelRemainingCounts(jobs);
  }

  return addedJobs.map((j) => j.id || "");
}

export async function clearDetectionSessions(): Promise<void> {
  const keys = await scanKeys(`${DETECTION_SESSION_PREFIX}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export async function createDetectionSession(
  channels: SessionChannelJobs[],
  activeChannelLimit: number,
  channelConcurrency: number
): Promise<{ sessionId: string; jobIds: string[] }> {
  const effectiveActiveChannelLimit = Math.max(1, activeChannelLimit);
  const effectiveChannelConcurrency = Math.max(1, channelConcurrency);
  const nonEmptyChannels = channels.filter((channel) => channel.jobs.length > 0);

  if (nonEmptyChannels.length === 0) {
    return { sessionId: "", jobIds: [] };
  }

  const sessionId = randomUUID();
  const activeChannels = nonEmptyChannels.slice(0, effectiveActiveChannelLimit);
  const waitingChannels = nonEmptyChannels.slice(effectiveActiveChannelLimit);
  const allJobs = nonEmptyChannels.flatMap((channel) => channel.jobs);

  await applyModelRemainingCounts(allJobs);

  const pipeline = redis.pipeline();
  for (const channel of nonEmptyChannels) {
    const jobsKey = getSessionChannelJobsKey(sessionId, channel.channelId);
    if (channel.jobs.length > 0) {
      pipeline.rpush(jobsKey, ...channel.jobs.map((job) => serializeDetectionJob({
        ...job,
        sessionId,
      })));
      pipeline.expire(jobsKey, DETECTION_SESSION_TTL);
    }
  }
  if (activeChannels.length > 0) {
    pipeline.sadd(getSessionActiveChannelsKey(sessionId), ...activeChannels.map((channel) => channel.channelId));
    pipeline.expire(getSessionActiveChannelsKey(sessionId), DETECTION_SESSION_TTL);
  }
  if (waitingChannels.length > 0) {
    pipeline.rpush(getSessionPendingChannelsKey(sessionId), ...waitingChannels.map((channel) => channel.channelId));
    pipeline.expire(getSessionPendingChannelsKey(sessionId), DETECTION_SESSION_TTL);
  }
  await pipeline.exec();

  const jobIds: string[] = [];
  for (const channel of activeChannels) {
    const added = await enqueueSessionChannelJobs(sessionId, channel.channelId, effectiveChannelConcurrency);
    jobIds.push(...added);
  }

  return { sessionId, jobIds };
}

/**
 * Get queue statistics
 */
export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  pendingSession: number;
  total: number;
}

async function getPendingSessionJobs(): Promise<DetectionJobData[]> {
  const keys = await scanKeys(`${DETECTION_SESSION_PREFIX}*:channel:*:jobs`);
  if (keys.length === 0) {
    return [];
  }

  const jobs: DetectionJobData[] = [];
  for (const key of keys) {
    const items = await redis.lrange(key, 0, -1);
    for (const item of items) {
      const job = parseDetectionJob(item);
      if (job) {
        jobs.push(job);
      }
    }
  }

  return jobs;
}

export function isQueueRunning(stats: Pick<QueueStats, "active" | "waiting" | "delayed" | "pendingSession">): boolean {
  return stats.active > 0 || stats.waiting > 0 || stats.delayed > 0 || stats.pendingSession > 0;
}

export async function getQueueStats(): Promise<QueueStats> {
  const queue = getDetectionQueue();
  const [waiting, active, completed, failed, delayed, pendingSessionJobs] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
    getPendingSessionJobs(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    pendingSession: pendingSessionJobs.length,
    total: waiting + active + delayed + pendingSessionJobs.length,
  };
}

/**
 * Get model IDs currently being tested (waiting + active + delayed)
 */
export async function getTestingModelIds(): Promise<string[]> {
  const queue = getDetectionQueue();

  const [waitingJobs, activeJobs, delayedJobs, pendingSessionJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 1000),
    queue.getJobs(["active"], 0, 100),
    queue.getJobs(["delayed"], 0, 1000),
    getPendingSessionJobs(),
  ]);

  // Extract unique model IDs from job data
  const modelIds = new Set<string>();
  for (const job of [...waitingJobs, ...activeJobs, ...delayedJobs]) {
    if (job.data?.modelId) {
      modelIds.add(job.data.modelId);
    }
  }
  for (const job of pendingSessionJobs) {
    if (job.modelId) {
      modelIds.add(job.modelId);
    }
  }

  return Array.from(modelIds);
}

/**
 * Get channel IDs currently being tested (waiting + active + delayed)
 */
export async function getTestingChannelIds(): Promise<Set<string>> {
  const queue = getDetectionQueue();

  const [waitingJobs, activeJobs, delayedJobs, pendingSessionJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 1000),
    queue.getJobs(["active"], 0, 100),
    queue.getJobs(["delayed"], 0, 1000),
    getPendingSessionJobs(),
  ]);

  const channelIds = new Set<string>();
  for (const job of [...waitingJobs, ...activeJobs, ...delayedJobs]) {
    if (job.data?.channelId) {
      channelIds.add(job.data.channelId);
    }
  }
  for (const job of pendingSessionJobs) {
    if (job.channelId) {
      channelIds.add(job.channelId);
    }
  }

  return channelIds;
}

/**
 * Clear all jobs from the queue
 */
export async function clearQueue(): Promise<void> {
  const queue = getDetectionQueue();
  await queue.obliterate({ force: true });
}

/**
 * Scan Redis keys by pattern (替代 KEYS 命令，避免阻塞)
 */
async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

/**
 * Pause queue and drain all waiting jobs (for stopping detection)
 * Also cancels active jobs by moving them to failed state
 * Returns the number of jobs that were cleared
 */
export async function pauseAndDrainQueue(): Promise<{ cleared: number }> {
  const queue = getDetectionQueue();
  const handleRemoveJobError = createAsyncErrorHandler("[Queue] 删除任务失败", "warn");

  // Set stopped flag so workers skip remaining jobs
  await redis.set(DETECTION_STOPPED_KEY, "1", "EX", DETECTION_STOPPED_TTL);

  // Pause the queue globally to prevent new jobs from being processed across all workers
  await queue.pause();

  let cleared = 0;

  try {
    // Get counts before clearing
    const [waiting, delayed, activeJobs] = await Promise.all([
      queue.getWaitingCount(),
      queue.getDelayedCount(),
      queue.getJobs(["active"], 0, 1000),
    ]);

    const activeCount = activeJobs.length;

    // Move active jobs to failed state to stop them
    // This signals the worker to stop processing these jobs
    const failPromises = activeJobs.map(async (job) => {
      try {
        // Use discardJob for safer cancellation, fallback to moveToFailed
        if (job.token) {
          await job.moveToFailed(new Error("Detection stopped by user"), job.token, true);
        } else {
          // If no token, try to remove the job directly
          await job.remove().catch(handleRemoveJobError);
        }
      } catch (error) {
        logWarn("[Queue] 取消活动任务失败", error);
      }
    });
    await Promise.allSettled(failPromises);

    // Drain waiting and delayed jobs (true = also drain delayed)
    await queue.drain(true);

    // Clear Redis semaphore counters to reset concurrency tracking
    const semaphoreKeys = await scanKeys("detection:semaphore:*");
    if (semaphoreKeys.length > 0) {
      await redis.del(...semaphoreKeys);
    }

    // Clear model remaining counters
    const modelRemainingKeys = await scanKeys(`${MODEL_REMAINING_PREFIX}*`);
    if (modelRemainingKeys.length > 0) {
      await redis.del(...modelRemainingKeys);
    }

    await clearDetectionSessions();

    cleared = waiting + delayed + activeCount;
  } finally {
    // Always resume queue, even if an error occurred during cleanup
    await queue.resume();
  }

  return { cleared };
}

/**
 * Check if detection has been stopped by user
 */
export async function isDetectionStopped(): Promise<boolean> {
  const value = await redis.get(DETECTION_STOPPED_KEY);
  return value === "1";
}

/**
 * Clear the detection stopped flag (called when starting new detection)
 */
export async function clearStoppedFlag(): Promise<void> {
  await redis.del(DETECTION_STOPPED_KEY);
}

/**
 * Mark models as cancelled (for selective stop of active jobs)
 */
export async function markModelsCancelled(modelIds: string[]): Promise<void> {
  if (modelIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const modelId of modelIds) {
    pipeline.sadd(CANCELLED_MODELS_KEY, modelId);
  }
  pipeline.expire(CANCELLED_MODELS_KEY, CANCELLED_MODELS_TTL);
  await pipeline.exec();
}

export async function isModelCancelled(modelId: string): Promise<boolean> {
  return (await redis.sismember(CANCELLED_MODELS_KEY, modelId)) === 1;
}

export async function clearModelCancelled(modelId: string): Promise<void> {
  await redis.srem(CANCELLED_MODELS_KEY, modelId);
}

export async function clearModelsCancelled(modelIds: string[]): Promise<void> {
  if (modelIds.length === 0) return;
  await redis.srem(CANCELLED_MODELS_KEY, ...modelIds);
}

/**
 * Save current completed/failed counts as baseline for progress calculation
 */
export async function saveProgressBaseline(): Promise<void> {
  const queue = getDetectionQueue();
  const [completed, failed] = await Promise.all([
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);
  await redis.set(PROGRESS_BASELINE_KEY, JSON.stringify({ completed, failed }), "EX", 7200);
}

export async function getProgressBaseline(): Promise<{ completed: number; failed: number }> {
  const data = await redis.get(PROGRESS_BASELINE_KEY);
  if (!data) return { completed: 0, failed: 0 };
  try {
    return JSON.parse(data);
  } catch {
    return { completed: 0, failed: 0 };
  }
}

/**
 * Decrement remaining job count for a model, return true if model detection is complete
 */
export async function decrementModelRemaining(modelId: string): Promise<boolean> {
  const key = `${MODEL_REMAINING_PREFIX}${modelId}`;
  const remaining = await redis.decr(key);
  if (remaining <= 0) {
    await redis.del(key);
    return true;
  }
  return false;
}

export async function decrementModelRemainingBy(modelId: string, count: number): Promise<boolean> {
  if (count <= 0) {
    return false;
  }

  const key = `${MODEL_REMAINING_PREFIX}${modelId}`;
  const remaining = await redis.decrby(key, count);
  if (remaining <= 0) {
    await redis.del(key);
    return true;
  }
  return false;
}

export async function onDetectionJobSettled(
  job: DetectionJobData,
  channelConcurrency: number,
  detectionStopped: boolean
): Promise<void> {
  if (!job.sessionId) {
    return;
  }

  const sessionId = job.sessionId;
  await withChannelSessionLock(sessionId, job.channelId, async () => {
    const inflightKey = getSessionChannelInflightKey(sessionId, job.channelId);
    const activeChannelsKey = getSessionActiveChannelsKey(sessionId);
    const pendingChannelsKey = getSessionPendingChannelsKey(sessionId);

    const remainingInflight = await redis.decr(inflightKey);
    if (remainingInflight <= 0) {
      await redis.del(inflightKey);
    } else {
      await redis.expire(inflightKey, DETECTION_SESSION_TTL);
    }

    if (!detectionStopped) {
      const refilled = await enqueueSessionChannelJobs(sessionId, job.channelId, 1);
      if (refilled.length > 0) {
        return;
      }
    }

    const currentInflight = remainingInflight > 0 ? remainingInflight : 0;
    if (currentInflight > 0) {
      return;
    }

    await redis.srem(activeChannelsKey, job.channelId);

    if (!detectionStopped) {
      while (true) {
        const nextChannelId = await redis.lpop(pendingChannelsKey);
        if (!nextChannelId) {
          break;
        }

        await redis.sadd(activeChannelsKey, nextChannelId);
        const activatedJobIds = await enqueueSessionChannelJobs(
          sessionId,
          nextChannelId,
          Math.max(1, channelConcurrency)
        );
        if (activatedJobIds.length > 0) {
          break;
        }
        await redis.srem(activeChannelsKey, nextChannelId);
      }
    }

    await cleanupDetectionSessionIfIdle(sessionId);
  });
}

async function removePendingSessionJobsByModelIds(modelIds: string[]): Promise<Map<string, number>> {
  const modelIdSet = new Set(modelIds);
  const removedByModel = new Map<string, number>();
  const keys = await scanKeys(`${DETECTION_SESSION_PREFIX}*:channel:*:jobs`);

  for (const key of keys) {
    const items = await redis.lrange(key, 0, -1);
    if (items.length === 0) {
      continue;
    }

    const kept: string[] = [];
    let removedInKey = 0;
    for (const item of items) {
      const job = parseDetectionJob(item);
      if (job?.modelId && modelIdSet.has(job.modelId)) {
        removedInKey += 1;
        removedByModel.set(job.modelId, (removedByModel.get(job.modelId) || 0) + 1);
        continue;
      }
      kept.push(item);
    }

    if (removedInKey === 0) {
      continue;
    }

    const pipeline = redis.pipeline();
    pipeline.del(key);
    if (kept.length > 0) {
      pipeline.rpush(key, ...kept);
      pipeline.expire(key, DETECTION_SESSION_TTL);
    }
    await pipeline.exec();
  }

  return removedByModel;
}

/**
 * Remove waiting/delayed jobs for specific model IDs (选择性停止)
 */
export async function removeJobsByModelIds(modelIds: string[]): Promise<{
  cleared: number;
  removedWaiting: number;
  removedPending: number;
  signaledActive: number;
}> {
  const queue = getDetectionQueue();
  const modelIdSet = new Set(modelIds);

  const [waitingJobs, delayedJobs, activeJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 5000),
    queue.getJobs(["delayed"], 0, 5000),
    queue.getJobs(["active"], 0, 1000),
  ]);

  const jobsToRemove = [...waitingJobs, ...delayedJobs]
    .filter((job) => job.data?.modelId && modelIdSet.has(job.data.modelId));

  const removeResults = await Promise.allSettled(
    jobsToRemove.map(async (job) => {
      await job.remove();
      return job.data.modelId;
    })
  );

  const removedWaiting = removeResults.filter(r => r.status === "fulfilled").length;
  const removedPendingByModel = await removePendingSessionJobsByModelIds(modelIds);
  const removedPending = Array.from(removedPendingByModel.values()).reduce((sum, count) => sum + count, 0);

  // Mark models as cancelled so active jobs skip DB writes
  await markModelsCancelled(modelIds);

  const activeModelIdSet = new Set(
    activeJobs
      .map((job) => job.data?.modelId)
      .filter((modelId): modelId is string => !!modelId && modelIdSet.has(modelId))
  );

  const removedByModel = new Map<string, number>();
  for (const result of removeResults) {
    if (result.status !== "fulfilled") continue;
    const modelId = result.value;
    removedByModel.set(modelId, (removedByModel.get(modelId) || 0) + 1);
  }
  for (const [modelId, count] of removedPendingByModel) {
    removedByModel.set(modelId, (removedByModel.get(modelId) || 0) + count);
  }

  for (const [modelId, count] of removedByModel) {
    const isModelComplete = await decrementModelRemainingBy(modelId, count);
    if (isModelComplete && !activeModelIdSet.has(modelId)) {
      await clearModelCancelled(modelId);
    }
  }

  const signaledActive = activeModelIdSet.size > 0
    ? (await import("./worker")).cancelActiveDetectionsByModelIds(Array.from(activeModelIdSet))
    : 0;

  return {
    cleared: removedWaiting + removedPending + signaledActive,
    removedWaiting,
    removedPending,
    signaledActive,
  };
}
