// POST /v1beta/models/[...path] - Proxy Google Gemini API
// Handles:
//   - POST /v1beta/models/{model}:generateContent
//   - POST /v1beta/models/{model}:streamGenerateContent
// Automatically routes to the correct channel based on model name in path

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  createProxyRequestId,
  getUpstreamPathFromUrl,
  markProxyChannelKeyUnavailable,
  proxyRequest,
  recordProxyModelResult,
  recordProxyRequestLog,
  streamResponse,
  errorResponse,
  normalizeBaseUrl,
  type ProxyRequestAttemptLog,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import { createAsyncErrorHandler } from "@/lib/utils/error";
import {
  buildProxyFileBindingKey,
  extractProxyFileReferences,
  getProxyFileBinding,
  type ProxyFileBinding,
} from "@/lib/proxy/file-bindings";

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

function getActualModelName(modelName: string): string {
  const slashIndex = modelName.indexOf("/");
  return slashIndex > 0 ? modelName.slice(slashIndex + 1) : modelName;
}

function isGeminiModelName(modelName: string): boolean {
  return getActualModelName(modelName).toLowerCase().includes("gemini");
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
    const requestId = createProxyRequestId();
    const upstreamAttempts: ProxyRequestAttemptLog[] = [];
    const handleWriteRequestLogError = createAsyncErrorHandler("[GeminiProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[GeminiProxy] 记录模型结果失败", "warn");
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
      requestId,
      requestPath,
      requestMethod,
      endpointType: "GEMINI",
      attempts: upstreamAttempts,
      ...options,
    }).catch(handleWriteRequestLogError);
    const addUpstreamAttempt = (attempt: ProxyRequestAttemptLog) => {
      upstreamAttempts.push({
        ...attempt,
        upstreamPath: attempt.upstreamPath ?? null,
        actualModelName: attempt.actualModelName ?? null,
        channelId: attempt.channelId ?? null,
        channelName: attempt.channelName ?? null,
        modelId: attempt.modelId ?? null,
        errorMsg: attempt.errorMsg ?? null,
      });
    };
    const recordModelResult = (
      modelId: Parameters<typeof recordProxyModelResult>[0],
      endpointType: Parameters<typeof recordProxyModelResult>[1],
      success: Parameters<typeof recordProxyModelResult>[2],
      options?: Parameters<typeof recordProxyModelResult>[3],
    ) => recordProxyModelResult(modelId, endpointType, success, {
      ...options,
      temporaryStopValue: keyResult?.keyRecord?.temporaryStopValue,
      temporaryStopUnit: keyResult?.keyRecord?.temporaryStopUnit,
    }).catch(handleRecordModelResultError);

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

    if (!isGeminiModelName(modelName)) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 400,
        errorMsg: "仅 Gemini 模型支持 /v1beta/models 接口",
      });
      return errorResponse("仅 Gemini 模型支持 /v1beta/models 接口", 400);
    }

    // Parse request body
    const body = await request.json();
    const fileRefs = Array.from(extractProxyFileReferences(body));
    const fileBindings = (await Promise.all(fileRefs.map((fileRef) => getProxyFileBinding(fileRef))))
      .filter((binding): binding is ProxyFileBinding => !!binding);
    const boundTargetKey = fileBindings.length > 0 ? buildProxyFileBindingKey(fileBindings[0]) : null;

    if (
      boundTargetKey &&
      fileBindings.some((binding) => buildProxyFileBindingKey(binding) !== boundTargetKey)
    ) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 400,
        errorMsg: "请求里混用了不同上游渠道上传的文件，不能一起分析",
      });
      return errorResponse("请求里混用了不同上游渠道上传的文件，不能一起分析", 400);
    }

    const candidateResult = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "GEMINI");
    const { isUnifiedRouting } = candidateResult;
    let { candidates } = candidateResult;

    if (boundTargetKey) {
      candidates = candidates.filter((candidate) =>
        candidate.channelKeyId
          ? `key:${candidate.channelKeyId}` === boundTargetKey
          : `channel:${candidate.channelId}` === boundTargetKey
      );
    }

    if (candidates.length === 0) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 404,
        errorMsg: boundTargetKey
          ? `文件所属上游渠道与当前模型不匹配: ${modelName}`
          : `Model not found or access denied: ${modelName}`,
      });
      return errorResponse(
        boundTargetKey
          ? `文件所属上游渠道与当前模型不匹配: ${modelName}`
          : `Model not found or access denied: ${modelName}`,
        404
      );
    }
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
          addUpstreamAttempt({
            endpointType: "GEMINI",
            upstreamPath: getUpstreamPathFromUrl(url),
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            success: false,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          });
          finalFailureLog = {
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          };

          if (channel.modelId) {
            await markProxyChannelKeyUnavailable(channel.modelId, response.status, lastErrorMessage);
            pendingFailures.push({
              modelId: channel.modelId,
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            });
          }

          continue;
        }

        addUpstreamAttempt({
          endpointType: "GEMINI",
          upstreamPath: getUpstreamPathFromUrl(url),
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: true,
          statusCode: response.status,
          latency,
        });

        if (isStream) {
          if (isUnifiedRouting && channel.modelId) {
            return streamResponse(response, {
              onComplete: () => Promise.all([
                recordModelResult(channel.modelId!, "GEMINI", true, {
                  latency,
                  statusCode: response.status,
                  responseContent: "代理流式请求成功",
                }),
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
                recordModelResult(channel.modelId!, "GEMINI", false, {
                  latency,
                  statusCode: 502,
                  errorMsg: "流式传输中断",
                }),
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
          await recordModelResult(channel.modelId, "GEMINI", true, {
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          });
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
        addUpstreamAttempt({
          endpointType: "GEMINI",
          upstreamPath: `/v1beta/models/${channel.actualModelName}:${method}`,
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: false,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        });
        finalFailureLog = {
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        };

        if (channel.modelId) {
          pendingFailures.push({
            modelId: channel.modelId,
            latency: Date.now() - startedAt,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          });
        }

        continue;
      }
    }

    if (pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordModelResult(failure.modelId, "GEMINI", false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          })
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
    const requestId = createProxyRequestId();
    const upstreamAttempts: ProxyRequestAttemptLog[] = [];
    const handleWriteRequestLogError = createAsyncErrorHandler("[GeminiProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[GeminiProxy] 记录模型结果失败", "warn");
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
      requestId,
      requestPath,
      requestMethod,
      endpointType: "GEMINI",
      attempts: upstreamAttempts,
      ...options,
    }).catch(handleWriteRequestLogError);
    const addUpstreamAttempt = (attempt: ProxyRequestAttemptLog) => {
      upstreamAttempts.push({
        ...attempt,
        upstreamPath: attempt.upstreamPath ?? null,
        actualModelName: attempt.actualModelName ?? null,
        channelId: attempt.channelId ?? null,
        channelName: attempt.channelName ?? null,
        modelId: attempt.modelId ?? null,
        errorMsg: attempt.errorMsg ?? null,
      });
    };
    const recordModelResult = (
      modelId: Parameters<typeof recordProxyModelResult>[0],
      endpointType: Parameters<typeof recordProxyModelResult>[1],
      success: Parameters<typeof recordProxyModelResult>[2],
      options?: Parameters<typeof recordProxyModelResult>[3],
    ) => recordProxyModelResult(modelId, endpointType, success, {
      ...options,
      temporaryStopValue: keyResult?.keyRecord?.temporaryStopValue,
      temporaryStopUnit: keyResult?.keyRecord?.temporaryStopUnit,
    }).catch(handleRecordModelResultError);

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

    if (!isGeminiModelName(modelName)) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 400,
        errorMsg: "仅 Gemini 模型支持 /v1beta/models 接口",
      });
      return errorResponse("仅 Gemini 模型支持 /v1beta/models 接口", 400);
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
          addUpstreamAttempt({
            endpointType: "GEMINI",
            upstreamPath: getUpstreamPathFromUrl(url),
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            success: false,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          });
          finalFailureLog = {
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          };

          if (channel.modelId) {
            await markProxyChannelKeyUnavailable(channel.modelId, response.status, lastErrorMessage);
            pendingFailures.push({
              modelId: channel.modelId,
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            });
          }

          continue;
        }

        addUpstreamAttempt({
          endpointType: "GEMINI",
          upstreamPath: getUpstreamPathFromUrl(url),
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: true,
          statusCode: response.status,
          latency,
        });

        const data = await response.json();

        if (isUnifiedRouting && channel.modelId) {
          await recordModelResult(channel.modelId, "GEMINI", true, {
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          });
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
        addUpstreamAttempt({
          endpointType: "GEMINI",
          upstreamPath: `/v1beta/models/${channel.actualModelName}`,
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: false,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        });
        finalFailureLog = {
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        };

        if (channel.modelId) {
          pendingFailures.push({
            modelId: channel.modelId,
            latency: Date.now() - startedAt,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          });
        }

        continue;
      }
    }

    if (pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordModelResult(failure.modelId, "GEMINI", false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          })
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
