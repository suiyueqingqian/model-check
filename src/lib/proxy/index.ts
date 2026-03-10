// Proxy utilities for API forwarding
// Routes requests to channels stored in database based on model name

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getRedisClient } from "@/lib/redis";
import { proxyFetch } from "@/lib/utils/proxy-fetch";
import {
  createAsyncErrorHandler,
  isClientStreamDisconnectError,
  isExpectedCloseError,
  logWarn,
} from "@/lib/utils/error";
import {
  BUILTIN_PROXY_KEY_DB_ID,
  getProxyApiKey,
  validateProxyKey,
  canAccessModel,
  type ValidateKeyResult,
} from "@/lib/utils/proxy-key";
import {
  isGptFiveOrNewerModel,
  isResponsesCompatibleChatModel,
} from "@/lib/utils/model-name";

// Round-robin counter: 优先使用 Redis INCR（多实例安全），无 Redis 时退回内存 Map
const roundRobinCounters = new Map<string, number>();
const ROUND_ROBIN_MAX_KEYS = 10000;
const ROUND_ROBIN_REDIS_PREFIX = "rr:";
const ROUND_ROBIN_REDIS_TTL = 3600;
let hasLoggedRoundRobinRedisFallback = false;

function evictRoundRobinCounters(): void {
  if (roundRobinCounters.size < ROUND_ROBIN_MAX_KEYS) return;
  const evictCount = Math.floor(roundRobinCounters.size / 2);
  let i = 0;
  for (const key of roundRobinCounters.keys()) {
    if (i++ >= evictCount) break;
    roundRobinCounters.delete(key);
  }
}

async function nextRoundRobin(counterKey: string): Promise<number> {
  try {
    const redis = getRedisClient();
    const redisKey = `${ROUND_ROBIN_REDIS_PREFIX}${counterKey}`;
    const val = await redis.incr(redisKey);
    if (val === 1) {
      await redis.expire(redisKey, ROUND_ROBIN_REDIS_TTL)
        .catch(createAsyncErrorHandler("[Proxy] 设置轮询计数过期时间失败", "warn"));
    }
    return val - 1;
  } catch (error) {
    if (!hasLoggedRoundRobinRedisFallback) {
      hasLoggedRoundRobinRedisFallback = true;
      logWarn("[Proxy] Redis 轮询计数不可用，已退回内存模式", error);
    }
  }
  if (roundRobinCounters.size >= ROUND_ROBIN_MAX_KEYS) {
    evictRoundRobinCounters();
  }
  const current = roundRobinCounters.get(counterKey) || 0;
  roundRobinCounters.set(counterKey, current + 1);
  return current;
}

/**
 * Safely parse JSON field as string array
 * Returns null if the value is not a valid string array
 */
function parseStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return null;
}

function supportsPreferredEndpoint(
  modelName: string,
  detectedEndpoints: string[],
  preferredEndpoint?: string
): boolean {
  if (!preferredEndpoint) {
    return true;
  }

  if (detectedEndpoints.includes(preferredEndpoint)) {
    return true;
  }

  if (detectedEndpoints.length === 0) {
    return true;
  }

  const normalizedName = modelName.toLowerCase();
  if (
    isGptFiveOrNewerModel(modelName) &&
    !normalizedName.includes("codex") &&
    (preferredEndpoint === "CHAT" || preferredEndpoint === "CODEX")
  ) {
    return (
      detectedEndpoints.includes("CHAT") ||
      detectedEndpoints.includes("CODEX")
    );
  }

  return false;
}

// Proxy request timeout (10 minutes for long-running CLI requests)
const PROXY_TIMEOUT = 600000;

// Global proxy from environment
const GLOBAL_PROXY = process.env.GLOBAL_PROXY;

// API types for different authentication schemes
export type ApiType = "openai" | "anthropic" | "gemini";

// Request context with validated key info
export interface ProxyRequestContext {
  keyResult: ValidateKeyResult;
}

export type ProxyEndpointType = "CHAT" | "CLAUDE" | "GEMINI" | "CODEX" | "IMAGE";

export interface ProxyRequestLogInput {
  keyResult?: ValidateKeyResult;
  requestPath: string;
  requestMethod: string;
  endpointType?: ProxyEndpointType;
  requestedModel?: string | null;
  actualModelName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  modelId?: string | null;
  isStream?: boolean;
  success: boolean;
  statusCode?: number;
  latency?: number;
  errorMsg?: string | null;
}

export interface ProxyChannelCandidate {
  channelId: string;
  channelName: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  actualModelName: string;
  modelId: string;
  modelStatus: boolean | null;
  detectedEndpoints: string[];
  preferredProxyEndpoint: "CHAT" | "CODEX" | null;
}

export interface ProxyChannelCandidateResult {
  isUnifiedRouting: boolean;
  candidates: ProxyChannelCandidate[];
}

/**
 * Verify proxy API key from request (legacy sync version)
 * Key is always required (auto-generated if not configured)
 */
export function verifyProxyKey(request: NextRequest): NextResponse | null {
  const expectedKey = getProxyApiKey();

  const authHeader = request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key");
  const googApiKey = request.headers.get("x-goog-api-key");

  // Accept key from any common header format
  const apiKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : xApiKey || googApiKey;

  if (!apiKey || apiKey !== expectedKey) {
    return NextResponse.json(
      {
        error: {
          message: "Invalid or missing API key",
          type: "authentication_error",
        },
      },
      { status: 401 }
    );
  }

  return null;
}

/**
 * Verify proxy API key from request (async version with multi-key support)
 * Returns the validated key result for permission checking
 */
export async function verifyProxyKeyAsync(request: NextRequest): Promise<{
  error?: NextResponse;
  keyResult?: ValidateKeyResult;
}> {
  const authHeader = request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key");
  const googApiKey = request.headers.get("x-goog-api-key");

  // Accept key from any common header format
  const apiKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : xApiKey || googApiKey;

  if (!apiKey) {
    return {
      error: NextResponse.json(
        {
          error: {
            message: "Missing API key",
            type: "authentication_error",
          },
        },
        { status: 401 }
      ),
    };
  }

  const keyResult = await validateProxyKey(apiKey);

  if (!keyResult.valid) {
    return {
      error: NextResponse.json(
        {
          error: {
            message: "Invalid API key",
            type: "authentication_error",
          },
        },
        { status: 401 }
      ),
    };
  }

  return { keyResult };
}

export async function recordProxyRequestLog(input: ProxyRequestLogInput): Promise<void> {
  const keyRecord = input.keyResult?.keyRecord;
  const proxyKeyId = keyRecord && keyRecord.id !== BUILTIN_PROXY_KEY_DB_ID
    ? keyRecord.id
    : null;

  await prisma.proxyRequestLog.create({
    data: {
      proxyKeyId,
      channelId: input.channelId ?? null,
      modelId: input.modelId ?? null,
      requestPath: input.requestPath,
      requestMethod: input.requestMethod,
      endpointType: input.endpointType ?? null,
      requestedModel: input.requestedModel ?? null,
      actualModelName: input.actualModelName ?? null,
      channelName: input.channelName ?? null,
      proxyKeyName: keyRecord?.name ?? null,
      isStream: input.isStream === true,
      success: input.success,
      statusCode: input.statusCode,
      latency: input.latency,
      errorMsg: input.errorMsg ? input.errorMsg.slice(0, 1000) : null,
    },
  });
}

/**
 * Find channel by model name
 * Supports both "modelName" and "channelName/modelName" formats
 * Returns the channel that contains the specified model
 * Supports multi-key routing (round_robin / random) and filters out invalid keys
 */
export async function findChannelByModel(modelName: string, preferredEndpoint?: string): Promise<ProxyChannelCandidate | null> {
  let actualModelName = modelName;

  // First, try exact match with full model name
  // This handles models with "/" in their name (e.g., "meta-llama/Llama-3-70b")
  let models = await prisma.model.findMany({
    where: {
      modelName,
      channel: { enabled: true },
    },
    select: {
      id: true,
      modelName: true,
      detectedEndpoints: true,
      lastStatus: true,
      preferredProxyEndpoint: true,
      channel: {
        select: {
          id: true,
          name: true,
          baseUrl: true,
          apiKey: true,
          proxy: true,
          enabled: true,
          sortOrder: true,
          createdAt: true,
          keyMode: true,
          routeStrategy: true,
        },
      },
      channelKey: {
        select: {
          apiKey: true,
          lastValid: true,
        },
      },
    },
    orderBy: [
      { channel: { sortOrder: "asc" } },
      { channel: { createdAt: "desc" } },
      { id: "asc" },
    ],
    take: 200,
  });

  // If no match and name contains "/", try "channelName/modelName" prefix format
  if (models.length === 0) {
    const slashIndex = modelName.indexOf("/");
    if (slashIndex > 0) {
      actualModelName = modelName.slice(slashIndex + 1);
      models = await prisma.model.findMany({
        where: {
          modelName: actualModelName,
          channel: {
            enabled: true,
            name: modelName.slice(0, slashIndex),
          },
        },
        select: {
          id: true,
          modelName: true,
          detectedEndpoints: true,
          lastStatus: true,
          preferredProxyEndpoint: true,
          channel: {
            select: {
              id: true,
              name: true,
              baseUrl: true,
              apiKey: true,
              proxy: true,
              enabled: true,
              sortOrder: true,
              createdAt: true,
              keyMode: true,
              routeStrategy: true,
            },
          },
          channelKey: {
            select: {
              apiKey: true,
              lastValid: true,
            },
          },
        },
        orderBy: [
          { channel: { sortOrder: "asc" } },
          { channel: { createdAt: "desc" } },
          { id: "asc" },
        ],
        take: 200,
      });
    }
  }

  if (models.length === 0) {
    return null;
  }

  // Filter out models whose channelKey is explicitly invalid
  // or model is not explicitly healthy.
  let validModels = models.filter((m) => {
    if (m.channelKey && m.channelKey.lastValid === false) return false;
    if (m.lastStatus !== true) return false;
    return true;
  });

  if (validModels.length === 0) {
    return null;
  }

  // 按端点类型过滤：只选择 detectedEndpoints 包含请求端点的模型
  if (preferredEndpoint && validModels.length > 0) {
    validModels = validModels.filter((m) =>
      supportsPreferredEndpoint(m.modelName, m.detectedEndpoints, preferredEndpoint)
    );
    if (validModels.length === 0) {
      return null;
    }
  }

  if (validModels.length === 0) {
    return null;
  }

  // Route within one channel only.
  // If multiple channels have same model name, pick the first channel by configured order.
  let selected;
  const primaryChannelId = validModels[0].channel.id;
  const sameChannelModels = validModels.filter((m) => m.channel.id === primaryChannelId);
  const channel = sameChannelModels[0].channel;

  if (channel.keyMode === "multi" && sameChannelModels.length > 1) {
    if (channel.routeStrategy === "random") {
      selected = sameChannelModels[Math.floor(Math.random() * sameChannelModels.length)];
    } else {
      // round_robin
      const counterKey = `${channel.id}:${actualModelName}`;
      const current = await nextRoundRobin(counterKey);
      selected = sameChannelModels[current % sameChannelModels.length];
    }
  } else {
    selected = sameChannelModels[0];
  }

  // Use channelKey's apiKey if available, otherwise fall back to channel's default
  const apiKey = selected.channelKey?.apiKey ?? selected.channel.apiKey;

  return {
    channelId: selected.channel.id,
    channelName: selected.channel.name,
    baseUrl: selected.channel.baseUrl.replace(/\/$/, ""),
    apiKey,
    proxy: selected.channel.proxy,
    actualModelName,
    modelId: selected.id,
    modelStatus: selected.lastStatus,
    detectedEndpoints: selected.detectedEndpoints,
    preferredProxyEndpoint:
      selected.preferredProxyEndpoint === "CHAT" || selected.preferredProxyEndpoint === "CODEX"
        ? selected.preferredProxyEndpoint
        : null,
  };
}

/**
 * Find channel for unified model mode
 * Searches across all channels for a bare model name, picks a healthy one
 */
async function getUnifiedModelCandidates(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidate[]> {
  const models = await prisma.model.findMany({
    where: {
      modelName,
      channel: { enabled: true },
      lastStatus: true,
    },
    select: {
      id: true,
      modelName: true,
      detectedEndpoints: true,
      lastStatus: true,
      preferredProxyEndpoint: true,
      channel: {
        select: {
          id: true,
          name: true,
          baseUrl: true,
          apiKey: true,
          proxy: true,
          enabled: true,
          sortOrder: true,
          createdAt: true,
          keyMode: true,
          routeStrategy: true,
        },
      },
      channelKey: {
        select: {
          apiKey: true,
          lastValid: true,
        },
      },
    },
    orderBy: [
      { channel: { sortOrder: "asc" } },
      { channel: { createdAt: "desc" } },
      { id: "asc" },
    ],
    take: 200,
  });

  // 过滤掉 channelKey 明确无效的
  const validModels = models.filter((m) => {
    if (m.channelKey && m.channelKey.lastValid === false) return false;
    return true;
  });

  // 按端点类型过滤：只选择 detectedEndpoints 包含请求端点的模型（有回退）
  let endpointFiltered = validModels;
  if (preferredEndpoint && validModels.length > 0) {
    endpointFiltered = validModels.filter((m) =>
      supportsPreferredEndpoint(m.modelName, m.detectedEndpoints, preferredEndpoint)
    );
    if (endpointFiltered.length === 0) {
      return [];
    }
  }

  if (endpointFiltered.length === 0) {
    return [];
  }

  // 统一模式权限过滤
  const keyRecord = keyResult.keyRecord;
  let permittedModels = endpointFiltered;
  if (keyRecord && !keyRecord.allowAllModels) {
    const allowedUnified = parseStringArray(keyRecord.allowedUnifiedModels);
    if (allowedUnified && allowedUnified.length > 0) {
      // 用 allowedUnifiedModels 做裸模型名匹配
      if (!allowedUnified.includes(modelName)) {
        return [];
      }
    } else {
      // 回退到现有 channelIds/modelIds 检查
      const allowedChannelIds = parseStringArray(keyRecord.allowedChannelIds);
      const allowedModelIds = parseStringArray(keyRecord.allowedModelIds);
      const hasChannelPerms = allowedChannelIds !== null && allowedChannelIds.length > 0;
      const hasModelPerms = allowedModelIds !== null && allowedModelIds.length > 0;
      if (!hasChannelPerms && !hasModelPerms) return [];
      permittedModels = endpointFiltered.filter((m) => {
        if (hasChannelPerms && allowedChannelIds!.includes(m.channel.id)) return true;
        if (hasModelPerms && allowedModelIds!.includes(m.id)) return true;
        return false;
      });
      if (permittedModels.length === 0) return [];
    }
  }

  // 同渠道多 key 按 routeStrategy 做组内负载均衡，每个渠道只出一个候选
  const channelGroups = new Map<string, typeof permittedModels>();
  for (const m of permittedModels) {
    const group = channelGroups.get(m.channel.id);
    if (group) {
      group.push(m);
    } else {
      channelGroups.set(m.channel.id, [m]);
    }
  }

  const balancedModels: typeof permittedModels = [];
  for (const [channelId, group] of channelGroups) {
    if (group.length <= 1) {
      balancedModels.push(...group);
    } else {
      const strategy = group[0].channel.routeStrategy;
      if (strategy === "random") {
        balancedModels.push(group[Math.floor(Math.random() * group.length)]);
      } else {
        const rrKey = `unified:${channelId}:${modelName}`;
        const idx = await nextRoundRobin(rrKey);
        balancedModels.push(group[idx % group.length]);
      }
    }
  }

  return balancedModels.map((selected) => ({
    channelId: selected.channel.id,
    channelName: selected.channel.name,
    baseUrl: selected.channel.baseUrl.replace(/\/$/, ""),
    apiKey: selected.channelKey?.apiKey ?? selected.channel.apiKey,
    proxy: selected.channel.proxy,
    actualModelName: modelName,
    modelId: selected.id,
    modelStatus: selected.lastStatus,
    detectedEndpoints: selected.detectedEndpoints,
    preferredProxyEndpoint:
      selected.preferredProxyEndpoint === "CHAT" || selected.preferredProxyEndpoint === "CODEX"
        ? selected.preferredProxyEndpoint
        : null,
  }));
}

async function orderUnifiedCandidatesRoundRobin(
  modelName: string,
  preferredEndpoint: string | undefined,
  candidates: ProxyChannelCandidate[]
): Promise<ProxyChannelCandidate[]> {
  if (candidates.length <= 1) {
    return candidates;
  }

  const counterKey = `unified:${preferredEndpoint || "ANY"}:${modelName}`;
  const current = await nextRoundRobin(counterKey);
  const startIndex = current % candidates.length;

  return [
    ...candidates.slice(startIndex),
    ...candidates.slice(0, startIndex),
  ];
}

async function findChannelByUnifiedModel(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidate | null> {
  const candidates = await getUnifiedModelCandidates(modelName, keyResult, preferredEndpoint);
  if (candidates.length === 0) {
    return null;
  }

  return (await orderUnifiedCandidatesRoundRobin(modelName, preferredEndpoint, candidates))[0];
}

/**
 * Find channel by model name with permission check
 * Returns null if the key doesn't have permission to access the model
 */
export async function findChannelByModelWithPermission(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidate | null> {
  // 统一模式：裸模型名（不含 /）走跨渠道路由
  const isUnifiedMode = keyResult.keyRecord?.unifiedMode === true;
  if (isUnifiedMode && !modelName.includes("/")) {
    return findChannelByUnifiedModel(modelName, keyResult, preferredEndpoint);
  }

  const channel = await findChannelByModel(modelName, preferredEndpoint);

  if (!channel) {
    return null;
  }

  // Check permission
  const hasPermission = await canAccessModel(
    keyResult.keyRecord,
    keyResult.isEnvKey,
    channel.channelId,
    channel.modelId,
    channel.modelStatus,
    channel.actualModelName
  );

  if (!hasPermission) {
    return null;
  }

  return channel;
}

export async function getProxyChannelCandidatesWithPermission(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidateResult> {
  const isUnifiedRouting = keyResult.keyRecord?.unifiedMode === true && !modelName.includes("/");

  if (isUnifiedRouting) {
    const candidates = await getUnifiedModelCandidates(modelName, keyResult, preferredEndpoint);
    return {
      isUnifiedRouting: true,
      candidates: await orderUnifiedCandidatesRoundRobin(modelName, preferredEndpoint, candidates),
    };
  }

  const channel = await findChannelByModelWithPermission(modelName, keyResult, preferredEndpoint);
  return {
    isUnifiedRouting: false,
    candidates: channel ? [channel] : [],
  };
}

export async function recordProxyModelResult(
  modelId: string,
  endpointType: ProxyEndpointType,
  success: boolean,
  options?: {
    channelId?: string;
    modelName?: string;
    latency?: number;
    statusCode?: number;
    errorMsg?: string;
    responseContent?: string;
  }
): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const currentModel = await tx.model.findUnique({
      where: { id: modelId },
      select: {
        modelName: true,
        detectedEndpoints: true,
      },
    });

    const currentDetectedEndpoints = currentModel?.detectedEndpoints ?? [];
    const isGptDualEndpointModel =
      !!currentModel?.modelName &&
      isResponsesCompatibleChatModel(currentModel.modelName) &&
      (endpointType === "CHAT" || endpointType === "CODEX");

    const alternateDetectedEndpoints = isGptDualEndpointModel
      ? currentDetectedEndpoints.filter(
          (endpoint) =>
            (endpoint === "CHAT" || endpoint === "CODEX") &&
            endpoint !== endpointType
        )
      : [];

    // 按状态码分级决定是否更新 lastStatus：
    // 成功 / 5xx / 401/403/404 → 更新（模型或渠道真有问题）
    // 400/422/429 等其他 4xx → 可能是用户侧问题，不更新
    const shouldUpdateStatus = success || !options?.statusCode ||
      (options.statusCode >= 500) ||
      [401, 403, 404].includes(options.statusCode);

    const shouldRemoveFailedEndpoint = !success &&
      [401, 403, 404].includes(options?.statusCode ?? 0) &&
      currentDetectedEndpoints.includes(endpointType);

    const nextDetectedEndpoints = shouldRemoveFailedEndpoint
      ? currentDetectedEndpoints.filter((endpoint) => endpoint !== endpointType)
      : currentDetectedEndpoints;

    const nextLastStatus = success
      ? true
      : isGptDualEndpointModel && alternateDetectedEndpoints.length > 0
        ? true
        : false;

    await tx.model.update({
      where: { id: modelId },
      data: {
        ...(shouldUpdateStatus ? { lastStatus: nextLastStatus } : {}),
        ...(shouldRemoveFailedEndpoint ? { detectedEndpoints: nextDetectedEndpoints } : {}),
        lastLatency: success ? (options?.latency ?? null) : null,
        lastCheckedAt: now,
      },
    });

    if (success) {
      await tx.$executeRaw`
        UPDATE "models"
        SET "detected_endpoints" =
          CASE
            WHEN ${endpointType} = ANY(COALESCE("detected_endpoints", ARRAY[]::text[])) THEN COALESCE("detected_endpoints", ARRAY[]::text[])
            ELSE COALESCE("detected_endpoints", ARRAY[]::text[]) || ARRAY[${endpointType}]
          END
        WHERE id = ${modelId}
      `;

      if (
        options?.channelId &&
        options?.modelName &&
        (endpointType === "CHAT" || endpointType === "CODEX")
      ) {
        await tx.model.update({
          where: { id: modelId },
          data: {
            preferredProxyEndpoint: endpointType,
          },
        });
      }
    }

    await tx.checkLog.create({
      data: {
        modelId,
        endpointType,
        status: success ? "SUCCESS" : "FAIL",
        latency: options?.latency,
        statusCode: options?.statusCode,
        errorMsg: success ? null : (options?.errorMsg || "代理请求失败"),
        responseContent: success ? (options?.responseContent || null) : null,
      },
    });
  });
}

export async function rememberPreferredProxyEndpoint(
  modelId: string,
  endpointType: "CHAT" | "CODEX"
): Promise<void> {
  await prisma.model.update({
    where: {
      id: modelId,
    },
    data: {
      preferredProxyEndpoint: endpointType,
    },
  });
}

/**
 * Get all available models from all enabled channels
 * Only returns models that are currently healthy (lastStatus === true)
 */
export async function getAllModelsWithChannels(keyResult?: ValidateKeyResult): Promise<
  Array<{
    id: string;
    modelName: string;
    channelName: string;
    channelId: string;
  }>
> {
  const whereConditions: Prisma.ModelWhereInput[] = [
    { channel: { enabled: true } },
    { lastStatus: true },
    {
      OR: [
        { channelKeyId: null },
        { channelKey: { is: { lastValid: { not: false } } } },
      ],
    },
  ];

  // If key has restricted permissions, filter by allowed channels/models
  if (keyResult?.keyRecord && !keyResult.keyRecord.allowAllModels) {
    const allowedChannelIds = parseStringArray(keyResult.keyRecord.allowedChannelIds);
    const allowedModelIds = parseStringArray(keyResult.keyRecord.allowedModelIds);

    const hasChannelPerms = allowedChannelIds !== null && allowedChannelIds.length > 0;
    const hasModelPerms = allowedModelIds !== null && allowedModelIds.length > 0;

    // If no explicit permissions configured, return empty (deny all)
    if (!hasChannelPerms && !hasModelPerms) {
      return [];
    }

    // Build OR condition: channel match OR model match
    if (hasChannelPerms && hasModelPerms) {
      whereConditions.push({
        OR: [
          { channelId: { in: allowedChannelIds } },
          { id: { in: allowedModelIds } },
        ],
      });
    } else if (hasChannelPerms) {
      whereConditions.push({
        channelId: { in: allowedChannelIds },
      });
    } else if (hasModelPerms) {
      whereConditions.push({
        id: { in: allowedModelIds },
      });
    }

    const allowedUnified = parseStringArray(keyResult.keyRecord.allowedUnifiedModels);
    if (allowedUnified && allowedUnified.length > 0) {
      whereConditions.push({
        modelName: { in: allowedUnified },
      });
    }
  }

  const models = await prisma.model.findMany({
    where: { AND: whereConditions },
    select: {
      id: true,
      modelName: true,
      channel: {
        select: { id: true, name: true },
      },
    },
    distinct: ["channelId", "modelName"],
    orderBy: [
      { channel: { name: "asc" } },
      { modelName: "asc" },
      { id: "asc" },
    ],
  });

  const uniqueModels = new Map<string, {
    id: string;
    modelName: string;
    channelName: string;
    channelId: string;
  }>();

  for (const m of models) {
    const dedupeKey = `${m.channel.id}\u0000${m.modelName}`;
    if (!uniqueModels.has(dedupeKey)) {
      uniqueModels.set(dedupeKey, {
        id: m.id,
        modelName: m.modelName,
        channelName: m.channel.name,
        channelId: m.channel.id,
      });
    }
  }

  return Array.from(uniqueModels.values());
}

/**
 * Get all available models, with unified mode dedup support
 */
export async function getAllModelsWithChannelsUnified(keyResult?: ValidateKeyResult): Promise<
  Array<{
    id: string;
    modelName: string;
    channelName: string;
    channelId: string;
  }>
> {
  const models = await getAllModelsWithChannels(keyResult);
  if (!keyResult?.keyRecord?.unifiedMode) {
    return models;
  }
  // 统一模式：按 modelName 去重，channelName 置空
  const seen = new Map<string, { id: string; modelName: string; channelName: string; channelId: string }>();
  for (const m of models) {
    if (!seen.has(m.modelName)) {
      seen.set(m.modelName, { ...m, channelName: "" });
    }
  }
  return Array.from(seen.values());
}

/**
 * Build headers for upstream request based on API type
 */
export function buildUpstreamHeaders(
  apiKey: string,
  apiType: ApiType,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (apiType) {
    case "openai":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "gemini":
      headers["x-goog-api-key"] = apiKey;
      break;
  }

  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  return headers;
}

/**
 * Proxy a request to upstream with optional proxy support
 */
export async function proxyRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  proxy?: string | null
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT);

  // Use channel proxy, fall back to global proxy
  const effectiveProxy = proxy || GLOBAL_PROXY;

  try {
    if (effectiveProxy) {
      // 使用代理发送请求
    }

    const response = await proxyFetch(
      url,
      {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
      effectiveProxy
    );

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${PROXY_TIMEOUT}ms`);
    }
    throw error;
  }
}

/**
 * Stream response from upstream endpoint
 * Supports:
 * - OpenAI/Anthropic SSE format (text/event-stream)
 * - Gemini JSON array streaming (application/json)
 * - OpenAI Responses API SSE format (event: + data:)
 */
export function streamResponse(
  upstream: Response,
  callbacks?: {
    onComplete?: () => void;
    onError?: (err: Error) => void;
  }
): Response {
  const reader = upstream.body?.getReader();

  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const IDLE_TIMEOUT_MS = 60000; // 60s idle timeout
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let canceled = false;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const completeByClientClose = (
    controller?: ReadableStreamDefaultController<Uint8Array>
  ) => {
    if (settled || canceled) {
      return;
    }
    settled = true;
    canceled = true;
    clearIdle();
    callbacks?.onComplete?.();
    if (controller) {
      try {
        controller.close();
      } catch (controllerError) {
        if (!isExpectedCloseError(controllerError)) {
          logWarn("[Proxy] 关闭客户端中断流失败", controllerError);
        }
      }
    }
  };

  const completeStream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (settled || canceled) {
      return;
    }
    settled = true;
    clearIdle();
    callbacks?.onComplete?.();
    controller.close();
  };

  const failStream = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: unknown
  ) => {
    if (settled || canceled) {
      return;
    }
    const error = err instanceof Error ? err : new Error("Upstream stream interrupted");
    if (isClientStreamDisconnectError(error)) {
      completeByClientClose(controller);
      reader.cancel().catch(createAsyncErrorHandler("[Proxy] 客户端中断后取消上游流失败", "warn"));
      return;
    }
    settled = true;
    clearIdle();
    callbacks?.onError?.(error);
    try {
      controller.error(error);
    } catch (controllerError) {
      if (!isExpectedCloseError(controllerError)) {
        logWarn("[Proxy] 写入流错误失败", controllerError);
      }
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const resetIdleTimer = () => {
        if (settled || canceled) {
          return;
        }
        clearIdle();
        idleTimer = setTimeout(() => {
          const err = new Error("Stream idle timeout (60s no data)");
          failStream(controller, err);
          reader.cancel().catch(createAsyncErrorHandler("[Proxy] 取消空闲流失败", "warn"));
        }, IDLE_TIMEOUT_MS);
      };

      resetIdleTimer();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            completeStream(controller);
            break;
          }
          resetIdleTimer();
          controller.enqueue(value);
        }
      } catch (err) {
        failStream(controller, err);
      }
    },
    cancel() {
      completeByClientClose();
      reader.cancel().catch(createAsyncErrorHandler("[Proxy] 取消下游已关闭流失败", "warn"));
    },
  });

  // Preserve the upstream Content-Type - important for different streaming formats:
  // - text/event-stream: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses API
  // - application/json: Gemini streamGenerateContent
  const contentType = upstream.headers.get("Content-Type");

  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Preserve transfer encoding for proper chunked streaming
      ...(upstream.headers.get("Transfer-Encoding") && {
        "Transfer-Encoding": upstream.headers.get("Transfer-Encoding")!,
      }),
    },
  });
}

/**
 * Wrap a Response body with stream completion/error tracking.
 * Used for converted/transformed streams where streamResponse callbacks can't be used.
 */
export function withStreamTracking(
  response: Response,
  onComplete: () => void,
  onError: (err: Error) => void
): Response {
  const body = response.body;
  if (!body) return response;

  const reader = body.getReader();
  let settled = false;
  let canceled = false;

  const completeByClientClose = (
    controller?: ReadableStreamDefaultController<Uint8Array>
  ) => {
    if (settled || canceled) {
      return;
    }
    settled = true;
    canceled = true;
    onComplete();
    if (controller) {
      try {
        controller.close();
      } catch {
        // controller already closed
      }
    }
  };

  const completeStream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (settled || canceled) {
      return;
    }
    settled = true;
    onComplete();
    controller.close();
  };

  const failStream = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: unknown
  ) => {
    if (settled || canceled) {
      return;
    }
    const error = err instanceof Error ? err : new Error("Stream tracking error");
    if (isClientStreamDisconnectError(error)) {
      completeByClientClose(controller);
      reader.cancel().catch(createAsyncErrorHandler("[Proxy] 客户端中断后取消跟踪流失败", "warn"));
      return;
    }
    settled = true;
    onError(error);
    try {
      controller.error(error);
    } catch {
      // controller already closed
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          completeStream(controller);
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        failStream(controller, err);
      }
    },
    cancel() {
      completeByClientClose();
      reader.cancel().catch(createAsyncErrorHandler("[Proxy] 取消已关闭跟踪流失败", "warn"));
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Create error response in JSON format
 */
export function errorResponse(message: string, status: number = 400): NextResponse {
  return NextResponse.json(
    {
      error: {
        message,
        type: "proxy_error",
      },
    },
    { status }
  );
}

/**
 * Normalize base URL - remove trailing slash and /v1 suffix
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}
