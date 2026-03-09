// POST /v1beta/models/[...path] - Proxy Google Gemini API
// Handles:
//   - POST /v1beta/models/{model}:generateContent
//   - POST /v1beta/models/{model}:streamGenerateContent
// Automatically routes to the correct channel based on model name in path

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
  recordProxyModelResult,
  recordProxyRequestLog,
  streamResponse,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKeyAsync,
} from "@/lib/proxy";

type ProxyAttemptFailure = {
  modelId: string;
  latency?: number;
  statusCode?: number;
  errorMsg: string;
};

function isPrefixedModelName(modelName: string): boolean {
  const slashIndex = modelName.indexOf("/");
  return slashIndex > 0 && slashIndex < modelName.length - 1;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const writeRequestLog = (options: {
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
    }) => recordProxyRequestLog({
      keyResult,
      requestPath,
      requestMethod,
      endpointType: "GEMINI",
      ...options,
    }).catch(() => {});

    // Reconstruct the path from catch-all segments
    const { path } = await params;
    const pathStr = path.join("/");

    // Extract model name from path (e.g., "gemini-1.5-flash:generateContent" -> "gemini-1.5-flash")
    const colonIndex = pathStr.indexOf(":");
    if (colonIndex === -1) {
      await writeRequestLog({
        requestedModel: null,
        success: false,
        statusCode: 400,
        errorMsg: "Invalid path format. Expected: /v1beta/models/{model}:{method}",
      });
      return errorResponse(
        "Invalid path format. Expected: /v1beta/models/{model}:{method}",
        400
      );
    }

    const modelName = pathStr.substring(0, colonIndex);
    const method = pathStr.substring(colonIndex + 1);

    const isUnifiedMode = keyResult?.keyRecord?.unifiedMode === true;
    if (!isUnifiedMode) {
      if (!isPrefixedModelName(modelName)) {
        await writeRequestLog({
          requestedModel: modelName,
          success: false,
          statusCode: 400,
          errorMsg: "Model must use channel prefix format: channelName/modelName",
        });
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (!modelName || modelName.trim().length === 0) {
        await writeRequestLog({
          requestedModel: modelName,
          success: false,
          statusCode: 400,
          errorMsg: "Missing or invalid model name in path",
        });
        return errorResponse("Missing or invalid model name in path", 400);
      }
    }

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "GEMINI");
    if (candidates.length === 0) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 404,
        errorMsg: `Model not found or access denied: ${modelName}`,
      });
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    // Parse request body
    const body = await request.json();

    const isStream = method === "streamGenerateContent";
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    let finalFailureLog: {
      actualModelName?: string | null;
      channelId?: string | null;
      channelName?: string | null;
      modelId?: string | null;
      statusCode?: number;
      latency?: number;
      errorMsg?: string | null;
    } | null = null;
    const pendingFailures: ProxyAttemptFailure[] = [];

    for (const channel of candidates) {
      const startedAt = Date.now();

      try {
        let baseUrl = normalizeBaseUrl(channel.baseUrl);
        if (baseUrl.endsWith("/v1beta")) {
          baseUrl = baseUrl.slice(0, -7);
        }

        const upstreamModelPath = `${channel.actualModelName}:${method}`;
        const url = `${baseUrl}/v1beta/models/${upstreamModelPath}`;
        const headers = buildUpstreamHeaders(channel.apiKey, "gemini");
        const response = await proxyRequest(url, "POST", headers, body, channel.proxy);
        const latency = Date.now() - startedAt;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
          lastStatus = response.status;
          finalFailureLog = {
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          };

          if (isUnifiedRouting && channel.modelId) {
            pendingFailures.push({
              modelId: channel.modelId,
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            });
            continue;
          }

          return errorResponse(lastErrorMessage, lastStatus);
        }

        if (isStream) {
          if (isUnifiedRouting && channel.modelId) {
            return streamResponse(response, {
              onComplete: () => Promise.all([
                recordProxyModelResult(channel.modelId!, "GEMINI", true, {
                  latency,
                  statusCode: response.status,
                  responseContent: "代理流式请求成功",
                }).catch(() => {}),
                writeRequestLog({
                  requestedModel: modelName,
                  actualModelName: channel.actualModelName,
                  channelId: channel.channelId,
                  channelName: channel.channelName,
                  modelId: channel.modelId,
                  isStream: true,
                  success: true,
                  statusCode: response.status,
                  latency,
                }),
              ]).then(() => {}),
              onError: () => Promise.all([
                recordProxyModelResult(channel.modelId!, "GEMINI", false, {
                  latency,
                  statusCode: 502,
                  errorMsg: "流式传输中断",
                }).catch(() => {}),
                writeRequestLog({
                  requestedModel: modelName,
                  actualModelName: channel.actualModelName,
                  channelId: channel.channelId,
                  channelName: channel.channelName,
                  modelId: channel.modelId,
                  isStream: true,
                  success: false,
                  statusCode: 502,
                  latency,
                  errorMsg: "流式传输中断",
                }),
              ]).then(() => {}),
            });
          }

          return streamResponse(response, {
            onComplete: () => writeRequestLog({
              requestedModel: modelName,
              actualModelName: channel.actualModelName,
              channelId: channel.channelId,
              channelName: channel.channelName,
              modelId: channel.modelId,
              isStream: true,
              success: true,
              statusCode: response.status,
              latency,
            }),
            onError: () => writeRequestLog({
              requestedModel: modelName,
              actualModelName: channel.actualModelName,
              channelId: channel.channelId,
              channelName: channel.channelName,
              modelId: channel.modelId,
              isStream: true,
              success: false,
              statusCode: 502,
              latency,
              errorMsg: "流式传输中断",
            }),
          });
        }

        const data = await response.json();

        if (isUnifiedRouting && channel.modelId) {
          await recordProxyModelResult(channel.modelId, "GEMINI", true, {
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          }).catch(() => {});
        }

        await writeRequestLog({
          requestedModel: modelName,
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          isStream: false,
          success: true,
          statusCode: response.status,
          latency,
        });

        return NextResponse.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lastErrorMessage = `Proxy error: ${message}`;
        lastStatus = 502;
        finalFailureLog = {
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        };

        if (isUnifiedRouting && channel.modelId) {
          pendingFailures.push({
            modelId: channel.modelId,
            latency: Date.now() - startedAt,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          });
          continue;
        }

        return errorResponse(lastErrorMessage, lastStatus);
      }
    }

    if (isUnifiedRouting && pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordProxyModelResult(failure.modelId, "GEMINI", false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          }).catch(() => {})
        )
      );
    }

    await writeRequestLog({
      requestedModel: modelName,
      actualModelName: finalFailureLog?.actualModelName ?? null,
      channelId: finalFailureLog?.channelId ?? null,
      channelName: finalFailureLog?.channelName ?? null,
      modelId: finalFailureLog?.modelId ?? null,
      isStream,
      success: false,
      statusCode: finalFailureLog?.statusCode ?? lastStatus,
      latency: finalFailureLog?.latency,
      errorMsg: finalFailureLog?.errorMsg ?? lastErrorMessage,
    });

    return errorResponse(lastErrorMessage, lastStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}

// Also support GET for model info requests
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const writeRequestLog = (options: {
      requestedModel?: string | null;
      actualModelName?: string | null;
      channelId?: string | null;
      channelName?: string | null;
      modelId?: string | null;
      success: boolean;
      statusCode?: number;
      latency?: number;
      errorMsg?: string | null;
    }) => recordProxyRequestLog({
      keyResult,
      requestPath,
      requestMethod,
      endpointType: "GEMINI",
      ...options,
    }).catch(() => {});

    const { path } = await params;
    const modelName = path.join("/");

    const isUnifiedMode = keyResult?.keyRecord?.unifiedMode === true;
    if (!isUnifiedMode) {
      if (!isPrefixedModelName(modelName)) {
        await writeRequestLog({
          requestedModel: modelName,
          success: false,
          statusCode: 400,
          errorMsg: "Model must use channel prefix format: channelName/modelName",
        });
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (!modelName || modelName.trim().length === 0) {
        await writeRequestLog({
          requestedModel: modelName,
          success: false,
          statusCode: 400,
          errorMsg: "Missing or invalid model name in path",
        });
        return errorResponse("Missing or invalid model name in path", 400);
      }
    }

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "GEMINI");
    if (candidates.length === 0) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 404,
        errorMsg: `Model not found or access denied: ${modelName}`,
      });
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    let finalFailureLog: {
      actualModelName?: string | null;
      channelId?: string | null;
      channelName?: string | null;
      modelId?: string | null;
      statusCode?: number;
      latency?: number;
      errorMsg?: string | null;
    } | null = null;
    const pendingFailures: ProxyAttemptFailure[] = [];

    for (const channel of candidates) {
      const startedAt = Date.now();

      try {
        let baseUrl = normalizeBaseUrl(channel.baseUrl);
        if (baseUrl.endsWith("/v1beta")) {
          baseUrl = baseUrl.slice(0, -7);
        }

        const url = `${baseUrl}/v1beta/models/${channel.actualModelName}`;
        const headers = buildUpstreamHeaders(channel.apiKey, "gemini");
        const response = await proxyRequest(url, "GET", headers, undefined, channel.proxy);
        const latency = Date.now() - startedAt;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
          lastStatus = response.status;
          finalFailureLog = {
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          };

          if (isUnifiedRouting && channel.modelId) {
            pendingFailures.push({
              modelId: channel.modelId,
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            });
            continue;
          }

          return errorResponse(lastErrorMessage, lastStatus);
        }

        const data = await response.json();

        if (isUnifiedRouting && channel.modelId) {
          await recordProxyModelResult(channel.modelId, "GEMINI", true, {
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          }).catch(() => {});
        }

        await writeRequestLog({
          requestedModel: modelName,
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: true,
          statusCode: response.status,
          latency,
        });

        return NextResponse.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lastErrorMessage = `Proxy error: ${message}`;
        lastStatus = 502;
        finalFailureLog = {
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        };

        if (isUnifiedRouting && channel.modelId) {
          pendingFailures.push({
            modelId: channel.modelId,
            latency: Date.now() - startedAt,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          });
          continue;
        }

        return errorResponse(lastErrorMessage, lastStatus);
      }
    }

    if (isUnifiedRouting && pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordProxyModelResult(failure.modelId, "GEMINI", false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          }).catch(() => {})
        )
      );
    }

    await writeRequestLog({
      requestedModel: modelName,
      actualModelName: finalFailureLog?.actualModelName ?? null,
      channelId: finalFailureLog?.channelId ?? null,
      channelName: finalFailureLog?.channelName ?? null,
      modelId: finalFailureLog?.modelId ?? null,
      success: false,
      statusCode: finalFailureLog?.statusCode ?? lastStatus,
      latency: finalFailureLog?.latency,
      errorMsg: finalFailureLog?.errorMsg ?? lastErrorMessage,
    });

    return errorResponse(lastErrorMessage, lastStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
