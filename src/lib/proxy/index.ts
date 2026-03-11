// Proxy utilities for API forwarding
// Routes requests to channels stored in database based on model name

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
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
  supportsOpenAIEndpointFallback,
  getLastSegmentModelName,
} from "@/lib/utils/model-name";

// Round-robin counter: 优先使用 Redis INCR（多实例安全），无 Redis 时退回内存 Map
const roundRobinCounters = new Map<string, number>();
const ROUND_ROBIN_MAX_KEYS = 10000;
const ROUND_ROBIN_REDIS_PREFIX = "rr:";
const ROUND_ROBIN_REDIS_TTL = 3600;
let hasLoggedRoundRobinRedisFallback = false;
const temporaryStopFallback = new Map<string, number>();
const TEMPORARY_STOP_MAX_KEYS = 10000;
const TEMPORARY_STOP_REDIS_PREFIX = "proxy-temp-stop:";
let hasLoggedTemporaryStopRedisFallback = false;
const TEMPORARY_STOP_UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

function isEnvFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function evictRoundRobinCounters(): void {
  if (roundRobinCounters.size < ROUND_ROBIN_MAX_KEYS) return;
  const evictCount = Math.floor(roundRobinCounters.size / 2);
  let i = 0;
  for (const key of roundRobinCounters.keys()) {
    if (i++ >= evictCount) break;
    roundRobinCounters.delete(key);
  }
}

function evictTemporaryStopFallback(): void {
  if (temporaryStopFallback.size < TEMPORARY_STOP_MAX_KEYS) return;
  const now = Date.now();
  for (const [key, expiresAt] of temporaryStopFallback.entries()) {
    if (expiresAt <= now) {
      temporaryStopFallback.delete(key);
    }
  }
  if (temporaryStopFallback.size < TEMPORARY_STOP_MAX_KEYS) return;
  const evictCount = Math.floor(temporaryStopFallback.size / 2);
  let i = 0;
  for (const key of temporaryStopFallback.keys()) {
    if (i++ >= evictCount) break;
    temporaryStopFallback.delete(key);
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

function buildTemporaryStopKey(modelId: string): string {
  return modelId;
}

function parseTemporaryStopCacheKey(cacheKey: string): { modelId: string } | null {
  const normalized = cacheKey.trim();
  if (!normalized) {
    return null;
  }

  return {
    modelId: normalized,
  };
}

function parseTemporaryStopRedisKey(redisKey: string): { modelId: string } | null {
  if (!redisKey.startsWith(TEMPORARY_STOP_REDIS_PREFIX)) {
    return null;
  }

  return parseTemporaryStopCacheKey(redisKey.slice(TEMPORARY_STOP_REDIS_PREFIX.length));
}

function getTemporaryStopDurationMs(
  temporaryStopValue?: number | null,
  temporaryStopUnit?: string | null
): number {
  if (!temporaryStopValue || temporaryStopValue <= 0) {
    return 0;
  }
  const unitMs = TEMPORARY_STOP_UNIT_MS[temporaryStopUnit || "minute"] ?? TEMPORARY_STOP_UNIT_MS.minute;
  return temporaryStopValue * unitMs;
}

async function rememberTemporaryStoppedCandidate(
  modelId: string,
  durationMs: number
): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  const cacheKey = buildTemporaryStopKey(modelId);
  const expiresAt = Date.now() + durationMs;

  try {
    const redis = getRedisClient();
    const ttlSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    await redis.set(
      `${TEMPORARY_STOP_REDIS_PREFIX}${cacheKey}`,
      String(expiresAt),
      "EX",
      ttlSeconds
    );
    return;
  } catch (error) {
    if (!hasLoggedTemporaryStopRedisFallback) {
      hasLoggedTemporaryStopRedisFallback = true;
      logWarn("[Proxy] Redis 临时停用缓存不可用，已退回内存模式", error);
    }
  }

  if (temporaryStopFallback.size >= TEMPORARY_STOP_MAX_KEYS) {
    evictTemporaryStopFallback();
  }
  temporaryStopFallback.set(cacheKey, expiresAt);
}

async function isCandidateTemporarilyStopped(modelId: string): Promise<boolean> {
  const cacheKey = buildTemporaryStopKey(modelId);

  try {
    const redis = getRedisClient();
    const rawValue = await redis.get(`${TEMPORARY_STOP_REDIS_PREFIX}${cacheKey}`);
    if (!rawValue) {
      return false;
    }
    const expiresAt = Number(rawValue);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  } catch (error) {
    if (!hasLoggedTemporaryStopRedisFallback) {
      hasLoggedTemporaryStopRedisFallback = true;
      logWarn("[Proxy] Redis 临时停用缓存不可用，已退回内存模式", error);
    }
  }

  const expiresAt = temporaryStopFallback.get(cacheKey);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    temporaryStopFallback.delete(cacheKey);
    return false;
  }
  return true;
}

export function shouldHideTemporaryStoppedModelsFromListing(): boolean {
  return isEnvFlagEnabled(process.env.TEMP_STOP_HIDE_FROM_MODELS, true);
}

export function shouldAllowAdminTemporaryStopBypass(): boolean {
  return isEnvFlagEnabled(process.env.TEMP_STOP_ALLOW_ADMIN_BYPASS, true);
}

export interface TemporaryStoppedChannelCredentialInfo {
  credentialKey: string;
  keyType: "main" | "channel";
  channelKeyId: string | null;
  name: string;
}

async function scanRedisKeys(pattern: string): Promise<string[]> {
  const redis = getRedisClient();
  const keys: string[] = [];
  let cursor = "0";

  do {
    const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");

  return keys;
}

export async function filterTemporaryStoppedModelsForListing<T extends { id: string }>(
  items: T[]
): Promise<T[]> {
  if (!shouldHideTemporaryStoppedModelsFromListing()) {
    return items;
  }

  if (items.length === 0) {
    return items;
  }

  const filtered: T[] = [];
  for (const item of items) {
    if (!(await isCandidateTemporarilyStopped(item.id))) {
      filtered.push(item);
    }
  }

  return filtered;
}

export async function clearTemporaryStoppedModel(
  modelId: string
): Promise<number> {
  let clearedCount = 0;

  if (temporaryStopFallback.delete(buildTemporaryStopKey(modelId))) {
    clearedCount += 1;
  }

  try {
    const redisKey = `${TEMPORARY_STOP_REDIS_PREFIX}${buildTemporaryStopKey(modelId)}`;
    const deletedCount = await getRedisClient().del(redisKey);
    if (deletedCount > 0) {
      clearedCount += deletedCount;
    }
  } catch (error) {
    if (!hasLoggedTemporaryStopRedisFallback) {
      hasLoggedTemporaryStopRedisFallback = true;
      logWarn("[Proxy] Redis 临时停用缓存清理失败，已退回内存模式", error);
    }
  }

  return clearedCount;
}

function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) {
    return "***";
  }
  if (apiKey.length <= 12) {
    return "***";
  }
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

function getTemporaryStoppedCredentialInfo(model: {
  channelKeyId: string | null;
  channelKey: { id: string; name: string | null; apiKey: string } | null;
}): TemporaryStoppedChannelCredentialInfo {
  if (!model.channelKeyId) {
    return {
      credentialKey: "__main__",
      keyType: "main",
      channelKeyId: null,
      name: "主 Key",
    };
  }

  const channelKeyName = model.channelKey?.name?.trim();
  const masked = maskApiKey(model.channelKey?.apiKey);

  return {
    credentialKey: model.channelKeyId,
    keyType: "channel",
    channelKeyId: model.channelKeyId,
    name: channelKeyName ? `${channelKeyName} (${masked})` : `子 Key ${masked}`,
  };
}

export async function getTemporaryStoppedChannelCredentialsByModelIds(
  modelIds: string[]
): Promise<Record<string, TemporaryStoppedChannelCredentialInfo | null>> {
  const targetModelIds = Array.from(new Set(modelIds.filter(Boolean)));
  if (targetModelIds.length === 0) {
    return {};
  }

  const targetModelIdSet = new Set(targetModelIds);
  const stoppedModelIdSet = new Set<string>();

  const now = Date.now();
  for (const [cacheKey, expiresAt] of temporaryStopFallback.entries()) {
    if (expiresAt <= now) {
      temporaryStopFallback.delete(cacheKey);
      continue;
    }

    const parsed = parseTemporaryStopCacheKey(cacheKey);
    if (!parsed || !targetModelIdSet.has(parsed.modelId)) {
      continue;
    }

    stoppedModelIdSet.add(parsed.modelId);
  }

  try {
    const redisKeys = await scanRedisKeys(`${TEMPORARY_STOP_REDIS_PREFIX}*`);
    for (const redisKey of redisKeys) {
      const parsed = parseTemporaryStopRedisKey(redisKey);
      if (!parsed || !targetModelIdSet.has(parsed.modelId)) {
        continue;
      }

      stoppedModelIdSet.add(parsed.modelId);
    }
  } catch (error) {
    if (!hasLoggedTemporaryStopRedisFallback) {
      hasLoggedTemporaryStopRedisFallback = true;
      logWarn("[Proxy] Redis 临时停用状态查询失败，已退回内存模式", error);
    }
  }

  const result: Record<string, TemporaryStoppedChannelCredentialInfo | null> = {};
  for (const modelId of targetModelIds) {
    result[modelId] = null;
  }

  if (stoppedModelIdSet.size === 0) {
    return result;
  }

  const stoppedModels = await prisma.model.findMany({
    where: {
      id: {
        in: Array.from(stoppedModelIdSet),
      },
    },
    select: {
      id: true,
      channelKeyId: true,
      channelKey: {
        select: {
          id: true,
          name: true,
          apiKey: true,
        },
      },
    },
  });

  for (const model of stoppedModels) {
    result[model.id] = getTemporaryStoppedCredentialInfo(model);
  }

  return result;
}

export async function getTemporaryStoppedModelsForChannel(channelId: string): Promise<Array<{
  id: string;
  modelName: string;
  temporaryStoppedCredential: TemporaryStoppedChannelCredentialInfo;
}>> {
  const models = await prisma.model.findMany({
    where: {
      channelId,
    },
    select: {
      id: true,
      modelName: true,
      channelKeyId: true,
      channelKey: {
        select: {
          id: true,
          name: true,
          apiKey: true,
        },
      },
    },
    orderBy: [
      { modelName: "asc" },
      { id: "asc" },
    ],
  });

  if (models.length === 0) {
    return [];
  }

  const temporaryStoppedCredentialByModelId = await getTemporaryStoppedChannelCredentialsByModelIds(
    models.map((item) => item.id)
  );

  return models
    .map((model) => ({
      id: model.id,
      modelName: model.modelName,
      temporaryStoppedCredential: temporaryStoppedCredentialByModelId[model.id],
    }))
    .filter((model): model is {
      id: string;
      modelName: string;
      temporaryStoppedCredential: TemporaryStoppedChannelCredentialInfo;
    } => Boolean(model.temporaryStoppedCredential));
}

export async function clearTemporaryStoppedModelsByChannel(
  channelId: string,
  credentialKey?: string
): Promise<{ clearedCount: number; clearedModels: number }> {
  const temporaryStoppedModels = await getTemporaryStoppedModelsForChannel(channelId);
  let clearedCount = 0;
  let clearedModels = 0;

  for (const model of temporaryStoppedModels) {
    if (
      credentialKey &&
      model.temporaryStoppedCredential.credentialKey !== credentialKey
    ) {
      continue;
    }

    const count = await clearTemporaryStoppedModel(model.id);
    if (count > 0) {
      clearedCount += count;
      clearedModels += 1;
    }
  }

  return {
    clearedCount,
    clearedModels,
  };
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

  if (
    supportsOpenAIEndpointFallback(modelName) &&
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

export interface ProxyRequestAttemptLog {
  endpointType?: ProxyEndpointType;
  upstreamPath?: string | null;
  actualModelName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  modelId?: string | null;
  success: boolean;
  statusCode?: number;
  latency?: number;
  errorMsg?: string | null;
}

export interface ProxyRequestLogInput {
  keyResult?: ValidateKeyResult;
  requestId?: string;
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
  attempts?: ProxyRequestAttemptLog[];
}

export interface ProxyChannelCandidate {
  channelId: string;
  channelName: string;
  channelKeyId: string | null;
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

export function createProxyRequestId(): string {
  return randomUUID();
}

export function getUpstreamPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

type RoutedModelRecord = {
  id: string;
  modelName: string;
  detectedEndpoints: string[];
  lastStatus: boolean | null;
  preferredProxyEndpoint: string | null;
  channelKeyId?: string | null;
  channel: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    proxy: string | null;
    keyMode: string;
    routeStrategy: string;
    mainKeyLastValid?: boolean | null;
  };
  channelKey: {
    apiKey: string;
    lastValid?: boolean | null;
  } | null;
};

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
  const attempts = Array.isArray(input.attempts)
    ? input.attempts.map((attempt) => ({
        endpointType: attempt.endpointType ?? null,
        upstreamPath: attempt.upstreamPath ?? null,
        actualModelName: attempt.actualModelName ?? null,
        channelId: attempt.channelId ?? null,
        channelName: attempt.channelName ?? null,
        modelId: attempt.modelId ?? null,
        success: attempt.success,
        statusCode: attempt.statusCode ?? null,
        latency: attempt.latency ?? null,
        errorMsg: attempt.errorMsg ? attempt.errorMsg.slice(0, 1000) : null,
      }))
    : [];
  const data = {
    requestId: input.requestId ?? null,
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
    attempts: attempts.length > 0 ? attempts : Prisma.JsonNull,
  };

  if (input.requestId) {
    await prisma.proxyRequestLog.upsert({
      where: { requestId: input.requestId },
      create: data,
      update: data,
    });
    return;
  }

  await prisma.proxyRequestLog.create({ data });
}

const routedModelSelect = {
  id: true,
  modelName: true,
  detectedEndpoints: true,
  lastStatus: true,
  preferredProxyEndpoint: true,
  channelKeyId: true,
  channel: {
    select: {
      id: true,
      name: true,
      baseUrl: true,
      apiKey: true,
      proxy: true,
      enabled: true,
      mainKeyLastValid: true,
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
} satisfies Prisma.ModelSelect;

function isCredentialAvailableForModel(model: RoutedModelRecord): boolean {
  if (model.channelKeyId) {
    return model.channelKey?.lastValid !== false;
  }

  return model.channel.mainKeyLastValid !== false;
}

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function buildProxyChannelCandidate(
  model: RoutedModelRecord,
  actualModelName: string
): ProxyChannelCandidate {
  return {
    channelId: model.channel.id,
    channelName: model.channel.name,
    channelKeyId: model.channelKeyId ?? null,
    baseUrl: model.channel.baseUrl.replace(/\/$/, ""),
    apiKey: model.channelKey?.apiKey ?? model.channel.apiKey,
    proxy: model.channel.proxy,
    actualModelName,
    modelId: model.id,
    modelStatus: model.lastStatus,
    detectedEndpoints: model.detectedEndpoints,
    preferredProxyEndpoint:
      model.preferredProxyEndpoint === "CHAT" || model.preferredProxyEndpoint === "CODEX"
        ? model.preferredProxyEndpoint
        : null,
  };
}

function getUnifiedModelName(modelName: string): string {
  return getLastSegmentModelName(modelName);
}

async function hasChannelPrefixInUnifiedMode(modelName: string): Promise<boolean> {
  const slashIndex = modelName.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= modelName.length - 1) {
    return false;
  }

  const channel = await prisma.channel.findUnique({
    where: { name: modelName.slice(0, slashIndex) },
    select: { id: true },
  });

  return !!channel;
}

export async function normalizeRequestedModelForProxy(
  modelName: string,
  keyResult?: ValidateKeyResult
): Promise<{ modelName: string; errorMsg?: string }> {
  const trimmedModelName = modelName.trim();

  if (keyResult?.keyRecord?.unifiedMode !== true) {
    return { modelName: trimmedModelName };
  }

  if (await hasChannelPrefixInUnifiedMode(trimmedModelName)) {
    return {
      modelName: trimmedModelName,
      errorMsg: "统一模型模式下不允许使用渠道名前缀，请只传模型名称",
    };
  }

  return {
    modelName: getUnifiedModelName(trimmedModelName),
  };
}

async function orderModelsWithinChannel(
  counterKey: string,
  group: RoutedModelRecord[]
): Promise<RoutedModelRecord[]> {
  if (group.length <= 1) {
    return group;
  }

  if (group[0].channel.routeStrategy === "random") {
    return shuffleArray(group);
  }

  const current = await nextRoundRobin(counterKey);
  const startIndex = current % group.length;
  return [
    ...group.slice(startIndex),
    ...group.slice(0, startIndex),
  ];
}

async function fetchModelCandidatesByName(
  modelName: string,
  preferredEndpoint?: string,
  allowChannelPrefixFallback = true
): Promise<{
  actualModelName: string;
  validModels: RoutedModelRecord[];
}> {
  let actualModelName = modelName;

  let models = await prisma.model.findMany({
    where: {
      modelName,
      channel: { enabled: true },
    },
    select: routedModelSelect,
    orderBy: [
      { channel: { sortOrder: "asc" } },
      { channel: { createdAt: "desc" } },
      { id: "asc" },
    ],
    take: 200,
  }) as RoutedModelRecord[];

  if (allowChannelPrefixFallback && models.length === 0) {
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
        select: routedModelSelect,
        orderBy: [
          { channel: { sortOrder: "asc" } },
          { channel: { createdAt: "desc" } },
          { id: "asc" },
        ],
        take: 200,
      }) as RoutedModelRecord[];
    }
  }

  if (models.length === 0) {
    return { actualModelName, validModels: [] };
  }

  let validModels = models.filter((m) => {
    if (m.lastStatus !== true) return false;
    if (!isCredentialAvailableForModel(m)) return false;
    return true;
  });

  if (preferredEndpoint && validModels.length > 0) {
    validModels = validModels.filter((m) =>
      supportsPreferredEndpoint(m.modelName, m.detectedEndpoints, preferredEndpoint)
    );
  }

  return { actualModelName, validModels };
}

async function getOrderedChannelCandidatesByModel(
  modelName: string,
  preferredEndpoint?: string,
  allowChannelPrefixFallback = true
): Promise<ProxyChannelCandidate[]> {
  const { actualModelName, validModels } = await fetchModelCandidatesByName(
    modelName,
    preferredEndpoint,
    allowChannelPrefixFallback
  );
  if (validModels.length === 0) {
    return [];
  }

  const primaryChannelId = validModels[0].channel.id;
  const sameChannelModels = validModels.filter((m) => m.channel.id === primaryChannelId);
  const orderedModels = await orderModelsWithinChannel(
    `${primaryChannelId}:${actualModelName}`,
    sameChannelModels
  );

  return orderedModels.map((model) => buildProxyChannelCandidate(model, actualModelName));
}

export async function markProxyChannelKeyUnavailable(
  modelId: string,
  statusCode?: number,
  errorMsg?: string
): Promise<void> {
  if (!shouldDisableChannelCredential(statusCode, errorMsg)) {
    return;
  }

  try {
    const model = await prisma.model.findUnique({
      where: { id: modelId },
      select: {
        id: true,
        channelId: true,
        channelKeyId: true,
      },
    });

    if (!model) {
      return;
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      if (model.channelKeyId) {
        await tx.channelKey.update({
          where: { id: model.channelKeyId },
          data: {
            lastValid: false,
            lastCheckedAt: now,
          },
        });
      } else {
        await tx.channel.update({
          where: { id: model.channelId },
          data: {
            mainKeyLastValid: false,
            mainKeyLastCheckedAt: now,
          },
        });
      }

      await tx.model.update({
        where: { id: modelId },
        data: { lastStatus: false },
      });
    });
  } catch (error) {
    logWarn("[Proxy] 标记模型不可用失败", error);
  }
}

function normalizeProxyErrorMessage(errorMsg?: string): string {
  return (errorMsg || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAnyPattern(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

async function filterTemporarilyStoppedCandidates(
  candidates: ProxyChannelCandidate[]
): Promise<ProxyChannelCandidate[]> {
  if (candidates.length === 0) {
    return candidates;
  }

  const filtered: ProxyChannelCandidate[] = [];
  for (const candidate of candidates) {
    if (!(await isCandidateTemporarilyStopped(candidate.modelId))) {
      filtered.push(candidate);
    }
  }
  return filtered;
}

function groupCandidatesByChannel(candidates: ProxyChannelCandidate[]): ProxyChannelCandidate[][] {
  const channelGroups = new Map<string, ProxyChannelCandidate[]>();
  for (const candidate of candidates) {
    const group = channelGroups.get(candidate.channelId);
    if (group) {
      group.push(candidate);
    } else {
      channelGroups.set(candidate.channelId, [candidate]);
    }
  }
  return Array.from(channelGroups.values());
}

function shouldDisableChannelCredential(statusCode?: number, errorMsg?: string): boolean {
  return classifyProxyFailure(statusCode, errorMsg) === "AUTH_INVALID";
}

type ProxyFailureCategory =
  | "AUTH_INVALID"
  | "RATE_LIMIT"
  | "MODEL_UNAVAILABLE"
  | "ENDPOINT_UNAVAILABLE"
  | "MODEL_PERMISSION"
  | "TRANSIENT"
  | "UNKNOWN";

function classifyProxyFailure(statusCode?: number, errorMsg?: string): ProxyFailureCategory {
  const normalizedMessage = normalizeProxyErrorMessage(errorMsg);

  if (statusCode === 401) {
    return "AUTH_INVALID";
  }

  const authErrorPatterns = [
    "invalid api key",
    "incorrect api key",
    "api key disabled",
    "api key revoked",
    "api key invalid",
    "api key not found",
    "api key has expired",
    "api key expired",
    "expired api key",
    "expired api token",
    "invalid x-api-key",
    "invalid x-goog-api-key",
    "invalid bearer token",
    "invalid authorization",
    "authentication failed",
    "invalid authentication",
    "invalid credentials",
    "authentication credentials were not provided",
    "authentication token is invalid",
    "authentication token has expired",
    "authentication token expired",
    "invalid auth token",
    "invalid access token",
    "access token invalid",
    "access token expired",
    "token expired",
    "token has expired",
    "token is expired",
    "invalid token",
    "key has been compromised",
    "api key has been blocked",
    "api key is blocked",
    "api key has been disabled",
    "api key has been revoked",
    "provided api key is invalid",
    "provided api key has expired",
    "provided api key is incorrect",
    "api key is invalid",
    "api key not valid",
    "permission denied due to invalid api key",
    "forbidden due to invalid api key",
    "unauthenticated",
    "not authenticated",
    "authentication required",
    "missing api key",
    "missing authentication",
    "missing access token",
    "no api key found",
    "revoked",
    "invalid or missing api key",
    "authentication_error",
    "reported as leaked",
    "leaked",
    "invalid key",
    "密钥无效",
    "api 密钥无效",
    "认证失败",
    "鉴权失败",
    "未认证",
    "令牌无效",
    "token 无效",
    "token已过期",
    "token 已过期",
    "访问令牌无效",
    "访问令牌已过期",
    "密钥已过期",
    "密钥已失效",
    "密钥不存在",
    "apikey无效",
    "apikey 不存在",
  ];

  if (includesAnyPattern(normalizedMessage, authErrorPatterns)) {
    return "AUTH_INVALID";
  }

  if (statusCode === 402 || statusCode === 429) {
    return "RATE_LIMIT";
  }

  const rateLimitPatterns = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "quota exceeded",
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "credits exhausted",
    "credit balance is too low",
    "account balance is insufficient",
    "overloaded",
    "overloaded_error",
    "requests are too frequent",
    "余额不足",
    "配额不足",
    "额度不足",
    "请求过多",
    "频率过高",
    "限流",
  ];

  if (includesAnyPattern(normalizedMessage, rateLimitPatterns)) {
    return "RATE_LIMIT";
  }

  const endpointNotFoundPatterns = [
    "endpoint not found",
    "method not found",
    "接口不存在",
    "方法不存在",
  ];

  if (includesAnyPattern(normalizedMessage, endpointNotFoundPatterns)) {
    return "ENDPOINT_UNAVAILABLE";
  }

  const modelNotFoundPatterns = [
    "model not found",
    "model_not_found",
    "model not find",
    "no such model",
    "unknown model",
    "unsupported model",
    "model is not supported",
    "model does not exist",
    "requested resource could not be found",
    "resource not found",
    "not found for api version",
    "does not exist",
    "publisher model is not enabled",
    "publisher model is disabled",
    "model has been deprecated",
    "model is deprecated",
    "model has been retired",
    "model retired",
    "模型不存在",
    "模型未找到",
    "模型不支持",
    "模型已下线",
    "模型已弃用",
    "资源不存在",
  ];

  if (
    includesAnyPattern(normalizedMessage, modelNotFoundPatterns) ||
    (normalizedMessage.includes("models/") && normalizedMessage.includes("is not found")) ||
    (normalizedMessage.includes("model ") && normalizedMessage.includes(" not found")) ||
    (normalizedMessage.includes("resource ") && normalizedMessage.includes(" not found"))
  ) {
    return "MODEL_UNAVAILABLE";
  }

  if (statusCode === 404) {
    return "ENDPOINT_UNAVAILABLE";
  }

  const modelPermissionPatterns = [
    "permission_error",
    "does not have permission to use the specified resource",
    "you do not have permission to access the requested resource",
    "you do not have access to this model",
    "you do not have access to the model",
    "not allowed to use this model",
    "not allowed to access this model",
    "model is not available for your account",
    "model is not available in your region",
    "model is unavailable in your region",
    "project is not allowed to use model",
    "project does not have access to model",
    "must be a member of an organization to use the api",
    "ip not authorized",
    "country, region, or territory not supported",
    "unsupported country",
    "unsupported region",
    "free tier is not available in your country",
    "user location is not supported for the api use",
    "access denied for model",
    "没有权限访问该模型",
    "没有权限使用该模型",
    "模型无权限",
    "地区不可用",
    "区域不可用",
  ];

  if (includesAnyPattern(normalizedMessage, modelPermissionPatterns)) {
    return "MODEL_PERMISSION";
  }

  if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 499 || statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 529) {
    return "TRANSIENT";
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return "TRANSIENT";
  }

  const transientPatterns = [
    "temporarily unavailable",
    "please try again later",
    "upstream 429",
    "upstream error: 429",
    "upstream error: 500",
    "upstream error: 502",
    "upstream error: 503",
    "upstream error: 504",
    "proxy error:",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "etimedout",
    "timeout",
    "timed out",
    "network error",
    "connection reset",
    "connection aborted",
    "connection refused",
    "temporarily blocked",
    "cloudflare",
    "cf-ray",
    "<html",
    "<!doctype html",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "服务繁忙",
    "暂时不可用",
    "网络错误",
    "超时",
  ];

  if (includesAnyPattern(normalizedMessage, transientPatterns)) {
    return "TRANSIENT";
  }

  return "UNKNOWN";
}

function shouldMarkModelUnavailable(statusCode?: number, errorMsg?: string): boolean {
  const category = classifyProxyFailure(statusCode, errorMsg);
  return category === "MODEL_UNAVAILABLE" ||
    category === "ENDPOINT_UNAVAILABLE" ||
    category === "MODEL_PERMISSION";
}

function isTransientProxyFailure(statusCode?: number, errorMsg?: string): boolean {
  const category = classifyProxyFailure(statusCode, errorMsg);
  return category === "RATE_LIMIT" || category === "TRANSIENT";
}

function isRateLimitProxyFailure(statusCode?: number, errorMsg?: string): boolean {
  return classifyProxyFailure(statusCode, errorMsg) === "RATE_LIMIT";
}

function shouldUpdateModelAvailability(success: boolean, statusCode?: number, errorMsg?: string): boolean {
  if (success) {
    return true;
  }

  if (shouldDisableChannelCredential(statusCode, errorMsg)) {
    return false;
  }

  if (shouldMarkModelUnavailable(statusCode, errorMsg)) {
    return true;
  }

  if (isTransientProxyFailure(statusCode, errorMsg)) {
    return true;
  }

  return false;
}

function shouldRemoveModelEndpoint(success: boolean, endpointType: ProxyEndpointType, detectedEndpoints: string[], statusCode?: number, errorMsg?: string): boolean {
  if (success || !detectedEndpoints.includes(endpointType)) {
    return false;
  }

  return shouldMarkModelUnavailable(statusCode, errorMsg);
}

/**
 * Find channel by model name
 * Supports both "modelName" and "channelName/modelName" formats
 * Returns the channel that contains the specified model
 * Supports multi-key routing (round_robin / random) and filters out invalid keys
 */
export async function findChannelByModel(modelName: string, preferredEndpoint?: string): Promise<ProxyChannelCandidate | null> {
  const candidates = await getOrderedChannelCandidatesByModel(modelName, preferredEndpoint);
  return candidates[0] ?? null;
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
  const unifiedModelName = getUnifiedModelName(modelName);
  const models = await prisma.model.findMany({
    where: {
      channel: { enabled: true },
      lastStatus: true,
      OR: [
        { modelName: unifiedModelName },
        { modelName: { endsWith: `/${unifiedModelName}` } },
      ],
    },
    select: routedModelSelect,
    orderBy: [
      { channel: { sortOrder: "asc" } },
      { channel: { createdAt: "desc" } },
      { id: "asc" },
    ],
    take: 200,
  });

  // 按端点类型过滤：只选择 detectedEndpoints 包含请求端点的模型（有回退）
  let endpointFiltered = models.filter((m) =>
    isCredentialAvailableForModel(m) && getUnifiedModelName(m.modelName) === unifiedModelName
  );
  if (preferredEndpoint && models.length > 0) {
    endpointFiltered = endpointFiltered.filter((m: RoutedModelRecord) =>
      supportsPreferredEndpoint(m.modelName, m.detectedEndpoints, preferredEndpoint)
    );
    if (endpointFiltered.length === 0) {
      return [];
    }
  }

  if (endpointFiltered.length === 0) {
    return [];
  }

  const keyRecord = keyResult.keyRecord;
  let permittedModels = endpointFiltered;
  if (keyRecord && !keyRecord.allowAllModels) {
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

  // 同渠道多 key 全部进入候选列表，组内顺序按 routeStrategy 排
  const channelGroups = new Map<string, typeof permittedModels>();
  for (const m of permittedModels) {
    const group = channelGroups.get(m.channel.id);
    if (group) {
      group.push(m);
    } else {
      channelGroups.set(m.channel.id, [m]);
    }
  }

  const orderedCandidates: ProxyChannelCandidate[] = [];
  for (const [channelId, group] of channelGroups) {
    const orderedModels = await orderModelsWithinChannel(`unified:${channelId}:${unifiedModelName}`, group);
    orderedCandidates.push(
      ...orderedModels.map((selected) => buildProxyChannelCandidate(selected, selected.modelName))
    );
  }

  return orderedCandidates;
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
  const groupedCandidates = groupCandidatesByChannel(candidates);
  const startIndex = current % groupedCandidates.length;
  return [
    ...groupedCandidates.slice(startIndex),
    ...groupedCandidates.slice(0, startIndex),
  ].flat();
}

function orderUnifiedCandidatesRandom(candidates: ProxyChannelCandidate[]): ProxyChannelCandidate[] {
  if (candidates.length <= 1) {
    return candidates;
  }
  return shuffleArray(groupCandidatesByChannel(candidates)).flat();
}

async function orderUnifiedCandidates(
  modelName: string,
  preferredEndpoint: string | undefined,
  candidates: ProxyChannelCandidate[],
  strategy: string | undefined
): Promise<ProxyChannelCandidate[]> {
  if ((strategy || "round_robin") === "random") {
    return orderUnifiedCandidatesRandom(candidates);
  }
  return orderUnifiedCandidatesRoundRobin(modelName, preferredEndpoint, candidates);
}

async function findChannelByUnifiedModel(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidate | null> {
  const candidates = await filterTemporarilyStoppedCandidates(
    await getUnifiedModelCandidates(modelName, keyResult, preferredEndpoint)
  );
  if (candidates.length === 0) {
    return null;
  }

  return (
    await orderUnifiedCandidates(
      modelName,
      preferredEndpoint,
      candidates,
      keyResult.keyRecord?.unifiedRouteStrategy
    )
  )[0];
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
  const isUnifiedMode = keyResult.keyRecord?.unifiedMode === true;
  if (isUnifiedMode) {
    return findChannelByUnifiedModel(getUnifiedModelName(modelName), keyResult, preferredEndpoint);
  }

  const candidates = await filterTemporarilyStoppedCandidates(
    await getOrderedChannelCandidatesByModel(modelName, preferredEndpoint, !isUnifiedMode)
  );
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const hasPermission = await canAccessModel(
      keyResult.keyRecord,
      keyResult.isEnvKey,
      candidate.channelId,
      candidate.modelId,
      candidate.modelStatus,
      candidate.actualModelName
    );

    if (hasPermission) {
      return candidate;
    }
  }

  return null;
}

export async function getProxyChannelCandidatesWithPermission(
  modelName: string,
  keyResult: ValidateKeyResult,
  preferredEndpoint?: string
): Promise<ProxyChannelCandidateResult> {
  const isUnifiedMode = keyResult.keyRecord?.unifiedMode === true;
  const unifiedModelName = isUnifiedMode ? getUnifiedModelName(modelName) : modelName;
  const isUnifiedRouting = isUnifiedMode;

  if (isUnifiedRouting) {
    const candidates = await filterTemporarilyStoppedCandidates(
      await getUnifiedModelCandidates(unifiedModelName, keyResult, preferredEndpoint)
    );
    return {
      isUnifiedRouting: true,
      candidates: await orderUnifiedCandidates(
        unifiedModelName,
        preferredEndpoint,
        candidates,
        keyResult.keyRecord?.unifiedRouteStrategy
      ),
    };
  }

  const candidates = await getOrderedChannelCandidatesByModel(
    modelName,
    preferredEndpoint,
    !isUnifiedMode
  );
  const permittedCandidates: ProxyChannelCandidate[] = [];
  for (const candidate of candidates) {
    const hasPermission = await canAccessModel(
      keyResult.keyRecord,
      keyResult.isEnvKey,
      candidate.channelId,
      candidate.modelId,
      candidate.modelStatus,
      candidate.actualModelName
    );

    if (hasPermission) {
      permittedCandidates.push(candidate);
    }
  }

  return {
    isUnifiedRouting: false,
    candidates: await filterTemporarilyStoppedCandidates(permittedCandidates),
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
    temporaryStopValue?: number;
    temporaryStopUnit?: string;
  }
): Promise<void> {
  const now = new Date();
  const temporaryStopDurationMs = getTemporaryStopDurationMs(
    options?.temporaryStopValue,
    options?.temporaryStopUnit
  );
  let shouldTemporaryStop = false;

  await prisma.$transaction(async (tx) => {
    const currentModel = await tx.model.findUnique({
      where: { id: modelId },
      select: {
        channelId: true,
        channelKeyId: true,
        modelName: true,
        detectedEndpoints: true,
      },
    });

    const currentDetectedEndpoints = currentModel?.detectedEndpoints ?? [];
    const alternateDetectedEndpoints = currentDetectedEndpoints.filter(
      (endpoint) => endpoint !== endpointType
    );
    const hasAlternateDetectedEndpoints = alternateDetectedEndpoints.length > 0;

    const shouldUpdateStatus = shouldUpdateModelAvailability(
      success,
      options?.statusCode,
      options?.errorMsg
    );

    const shouldRemoveFailedEndpoint = shouldRemoveModelEndpoint(
      success,
      endpointType,
      currentDetectedEndpoints,
      options?.statusCode,
      options?.errorMsg
    );

    const nextDetectedEndpoints = shouldRemoveFailedEndpoint
      ? currentDetectedEndpoints.filter((endpoint) => endpoint !== endpointType)
      : currentDetectedEndpoints;

    const nextLastStatus = success
      ? true
      : hasAlternateDetectedEndpoints
        ? true
        : false;

    shouldTemporaryStop = !success &&
      temporaryStopDurationMs > 0 &&
      !hasAlternateDetectedEndpoints &&
      isRateLimitProxyFailure(options?.statusCode, options?.errorMsg);

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

  if (shouldTemporaryStop) {
    await rememberTemporaryStoppedCandidate(
      modelId,
      temporaryStopDurationMs
    );
  }
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
  ];

  if (keyResult?.keyRecord && !keyResult.keyRecord.allowAllModels) {
    const allowedChannelIds = parseStringArray(keyResult.keyRecord.allowedChannelIds);
    const allowedModelIds = parseStringArray(keyResult.keyRecord.allowedModelIds);

    const hasChannelPerms = allowedChannelIds !== null && allowedChannelIds.length > 0;
    const hasModelPerms = allowedModelIds !== null && allowedModelIds.length > 0;

    if (!hasChannelPerms && !hasModelPerms) {
      return [];
    }

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
  const models = await filterTemporaryStoppedModelsForListing(
    await getAllModelsWithChannels(keyResult)
  );
  if (!keyResult?.keyRecord?.unifiedMode) {
    return models;
  }
  const seen = new Map<string, { id: string; modelName: string; channelName: string; channelId: string }>();
  for (const m of models) {
    const unifiedModelName = getUnifiedModelName(m.modelName);
    if (!seen.has(unifiedModelName)) {
      seen.set(unifiedModelName, { ...m, modelName: unifiedModelName, channelName: "" });
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
  extraHeaders?: Record<string, string>,
  options?: {
    includeContentType?: boolean;
  }
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (options?.includeContentType !== false) {
    headers["Content-Type"] = "application/json";
  }

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
