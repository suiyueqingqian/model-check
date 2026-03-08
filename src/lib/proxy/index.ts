// Proxy utilities for API forwarding
// Routes requests to channels stored in database based on model name

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { proxyFetch } from "@/lib/utils/proxy-fetch";
import { getProxyApiKey, validateProxyKey, canAccessModel, type ValidateKeyResult } from "@/lib/utils/proxy-key";

// Round-robin counter per channel (auto-clears when too many stale keys accumulate)
const roundRobinCounters = new Map<string, number>();
const ROUND_ROBIN_MAX_KEYS = 10000;

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

export type ProxyEndpointType = "CHAT" | "CLAUDE" | "GEMINI" | "CODEX";

export interface ProxyChannelCandidate {
  channelId: string;
  channelName: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  actualModelName: string;
  modelId: string;
  modelStatus: boolean | null;
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
    include: {
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
        include: {
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
    const matched = validModels.filter((m) =>
      m.detectedEndpoints.includes(preferredEndpoint)
    );
    if (matched.length > 0) {
      validModels = matched;
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
      if (roundRobinCounters.size >= ROUND_ROBIN_MAX_KEYS) {
        roundRobinCounters.clear();
      }
      const current = roundRobinCounters.get(counterKey) || 0;
      selected = sameChannelModels[current % sameChannelModels.length];
      roundRobinCounters.set(counterKey, (current + 1) % sameChannelModels.length);
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
    include: {
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

  // 按端点类型过滤：只选择 detectedEndpoints 包含请求端点的模型
  let endpointFiltered = validModels;
  if (preferredEndpoint && validModels.length > 0) {
    endpointFiltered = validModels.filter((m) =>
      m.detectedEndpoints.includes(preferredEndpoint)
    );
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

  return permittedModels.map((selected) => ({
    channelId: selected.channel.id,
    channelName: selected.channel.name,
    baseUrl: selected.channel.baseUrl.replace(/\/$/, ""),
    apiKey: selected.channelKey?.apiKey ?? selected.channel.apiKey,
    proxy: selected.channel.proxy,
    actualModelName: modelName,
    modelId: selected.id,
    modelStatus: selected.lastStatus,
  }));
}

function orderUnifiedCandidatesRoundRobin(
  modelName: string,
  preferredEndpoint: string | undefined,
  candidates: ProxyChannelCandidate[]
): ProxyChannelCandidate[] {
  if (candidates.length <= 1) {
    return candidates;
  }

  const counterKey = `unified:${preferredEndpoint || "ANY"}:${modelName}`;
  if (roundRobinCounters.size >= ROUND_ROBIN_MAX_KEYS) {
    roundRobinCounters.clear();
  }

  const current = roundRobinCounters.get(counterKey) || 0;
  const startIndex = current % candidates.length;
  roundRobinCounters.set(counterKey, (current + 1) % candidates.length);

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

  return orderUnifiedCandidatesRoundRobin(modelName, preferredEndpoint, candidates)[0];
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
    channel.modelStatus
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
      candidates: orderUnifiedCandidatesRoundRobin(modelName, preferredEndpoint, candidates),
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
    latency?: number;
    statusCode?: number;
    errorMsg?: string;
    responseContent?: string;
  }
): Promise<void> {
  const now = new Date();

  await prisma.$transaction([
    prisma.model.update({
      where: { id: modelId },
      data: {
        lastStatus: success,
        lastLatency: success ? (options?.latency ?? null) : null,
        lastCheckedAt: now,
      },
    }),
    prisma.checkLog.create({
      data: {
        modelId,
        endpointType,
        status: success ? "SUCCESS" : "FAIL",
        latency: options?.latency,
        statusCode: options?.statusCode,
        errorMsg: success ? null : (options?.errorMsg || "代理请求失败"),
        responseContent: success ? (options?.responseContent || null) : null,
      },
    }),
  ]);
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
  // Build where clause based on key permissions
  let whereClause: {
    channel: { enabled: boolean };
    lastStatus?: boolean;
    channelId?: { in: string[] };
    id?: { in: string[] };
    OR?: Array<
      | { channelId: { in: string[] } }
      | { id: { in: string[] } }
    >;
  } = {
    channel: { enabled: true },
    // Keep model list aligned with actual proxy routing behavior.
    lastStatus: true,
  };

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
      // Need to use Prisma OR logic - but findMany doesn't support top-level OR easily
      // So we'll filter by channelId OR modelId using two queries and merge
      // For simplicity, we use channelId filter first, then add model filter
      whereClause = {
        ...whereClause,
        OR: [
          { channelId: { in: allowedChannelIds } },
          { id: { in: allowedModelIds } },
        ],
      } as typeof whereClause;
    } else if (hasChannelPerms) {
      whereClause = {
        ...whereClause,
        channelId: { in: allowedChannelIds },
      };
    } else if (hasModelPerms) {
      whereClause = {
        ...whereClause,
        id: { in: allowedModelIds },
      };
    }
  }

  const models = await prisma.model.findMany({
    where: whereClause,
    include: {
      channel: {
        select: { id: true, name: true },
      },
      channelKey: {
        select: { lastValid: true },
      },
    },
    orderBy: [
      { channel: { name: "asc" } },
      { modelName: "asc" },
    ],
  });

  const availableModels = models.filter((m) => {
    if (m.channelKey && m.channelKey.lastValid === false) return false;
    return true;
  });

  const uniqueModels = new Map<string, {
    id: string;
    modelName: string;
    channelName: string;
    channelId: string;
  }>();

  for (const m of availableModels) {
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
export function streamResponse(upstream: Response): Response {
  const reader = upstream.body?.getReader();

  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch {
        // Upstream closed mid-stream — close gracefully so partial data still reaches the client
        try {
          controller.close();
        } catch {
          // controller already closed or errored, nothing to do
        }
      }
    },
    cancel() {
      reader.cancel();
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
