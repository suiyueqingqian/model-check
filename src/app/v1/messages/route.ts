// POST /v1/messages - Proxy Anthropic Claude Messages API
// Supports both streaming and non-streaming responses
// Streaming uses SSE with event types: message_start, content_block_delta, message_stop
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  createProxyRequestId,
  getUpstreamPathFromUrl,
  markProxyChannelKeyUnavailable,
  normalizeRequestedModelForProxy,
  proxyRequest,
  recordProxyModelResult,
  recordProxyRequestLog,
  streamResponse,
  errorResponse,
  normalizeBaseUrl,
  type ProxyRequestAttemptLog,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import {
  buildChatBodyFromClaudeRequest,
  buildClaudeMessageFromChat,
  buildClaudeMessageFromText,
  convertChatStreamToClaudeStream,
  createSyntheticClaudeStreamResponse,
  extractTextFromChatSse,
  extractTextFromClaudeSse,
  looksLikeSsePayload,
} from "@/lib/proxy/compat";
import { createAsyncErrorHandler } from "@/lib/utils/error";
import {
  buildProxyFileBindingKey,
  extractProxyFileReferences,
  getProxyFileBinding,
  type ProxyFileBinding,
} from "@/lib/proxy/file-bindings";

type ProxyAttemptFailure = {
  modelId: string;
  endpointType: "CLAUDE" | "CHAT";
  latency?: number;
  statusCode?: number;
  errorMsg: string;
};

type ClaudeProxyAttempt = {
  endpointType: "CLAUDE" | "CHAT";
  url: string;
  body: Record<string, unknown>;
  apiType: "anthropic" | "openai";
  extraHeaders?: Record<string, string>;
};

function getActualModelName(modelName: string): string {
  const slashIndex = modelName.indexOf("/");
  return slashIndex > 0 ? modelName.slice(slashIndex + 1) : modelName;
}

function isClaudeModelName(modelName: string): boolean {
  return getActualModelName(modelName).toLowerCase().includes("claude");
}

function isClaudeTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.every((item) => {
    if (typeof item === "string") {
      return true;
    }

    if (!item || typeof item !== "object") {
      return false;
    }

    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string";
  });
}

function canFallbackClaudeMessagesToChat(body: Record<string, unknown>): boolean {
  if ("tools" in body || "tool_choice" in body || "thinking" in body) {
    return false;
  }

  if (body.system !== undefined && !isClaudeTextOnlyContent(body.system)) {
    return false;
  }

  if (!Array.isArray(body.messages)) {
    return false;
  }

  return body.messages.every((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (role !== "user" && role !== "assistant") {
      return false;
    }

    return isClaudeTextOnlyContent(record.content);
  });
}

function getClaudeCandidatePriority(candidate: {
  detectedEndpoints: string[];
}): number {
  if (candidate.detectedEndpoints.includes("CLAUDE")) {
    return 0;
  }

  if (candidate.detectedEndpoints.includes("CHAT")) {
    return 1;
  }

  return 2;
}

async function readUpstreamTextPayload(response: Response): Promise<{
  text: string;
  isSse: boolean;
}> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  return {
    text,
    isSse: contentType.includes("text/event-stream") || looksLikeSsePayload(text),
  };
}

export async function POST(request: NextRequest) {
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const requestId = createProxyRequestId();
    const upstreamAttempts: ProxyRequestAttemptLog[] = [];
    const handleWriteRequestLogError = createAsyncErrorHandler("[ClaudeProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[ClaudeProxy] 记录模型结果失败", "warn");
    const writeRequestLog = (options: {
      endpointType?: "CLAUDE" | "CHAT";
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
      endpointType: options.endpointType ?? "CLAUDE",
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

    // Parse request body
    const body = await request.json();
    const modelName = body.model;
    const fileRefs = Array.from(extractProxyFileReferences(body));

    if (!modelName) {
      await writeRequestLog({
        requestedModel: null,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "Missing 'model' field in request body",
      });
      return errorResponse("Missing 'model' field in request body", 400);
    }

    const isUnifiedMode = keyResult?.keyRecord?.unifiedMode === true;
    if (!isUnifiedMode) {
      if (typeof modelName !== "string" || modelName.indexOf("/") <= 0 || modelName.endsWith("/")) {
        await writeRequestLog({
          requestedModel: typeof modelName === "string" ? modelName : null,
          isStream: body.stream === true,
          success: false,
          statusCode: 400,
          errorMsg: "Model must use channel prefix format: channelName/modelName",
        });
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (typeof modelName !== "string" || modelName.trim().length === 0) {
        await writeRequestLog({
          requestedModel: typeof modelName === "string" ? modelName : null,
          isStream: body.stream === true,
          success: false,
          statusCode: 400,
          errorMsg: "Missing or invalid 'model' field",
        });
        return errorResponse("Missing or invalid 'model' field", 400);
      }
    }
    const { modelName: routedModelName, errorMsg: normalizedModelError } =
      typeof modelName === "string"
        ? await normalizeRequestedModelForProxy(modelName, keyResult!)
        : { modelName: "" };
    if (normalizedModelError) {
      await writeRequestLog({
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: normalizedModelError,
      });
      return errorResponse(normalizedModelError, 400);
    }

    if (!isClaudeModelName(routedModelName)) {
      await writeRequestLog({
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "仅 Claude 模型支持 /v1/messages 接口",
      });
      return errorResponse("仅 Claude 模型支持 /v1/messages 接口", 400);
    }

    const fileBindings = (await Promise.all(fileRefs.map((fileRef) => getProxyFileBinding(fileRef))))
      .filter((binding): binding is ProxyFileBinding => !!binding);
    const boundTargetKey = fileBindings.length > 0 ? buildProxyFileBindingKey(fileBindings[0]) : null;

    if (
      boundTargetKey &&
      fileBindings.some((binding) => buildProxyFileBindingKey(binding) !== boundTargetKey)
    ) {
      await writeRequestLog({
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "请求里混用了不同上游渠道上传的文件，不能一起分析",
      });
      return errorResponse("请求里混用了不同上游渠道上传的文件，不能一起分析", 400);
    }

    const candidateResult = await getProxyChannelCandidatesWithPermission(routedModelName, keyResult!);
    const { isUnifiedRouting } = candidateResult;
    let { candidates } = candidateResult;
    const allowChatFallback = fileRefs.length === 0 && canFallbackClaudeMessagesToChat(body);

    if (boundTargetKey) {
      candidates = candidates.filter((candidate) =>
        candidate.channelKeyId
          ? `key:${candidate.channelKeyId}` === boundTargetKey
          : `channel:${candidate.channelId}` === boundTargetKey
      );
    }

    candidates = candidates
      .filter((candidate) =>
        candidate.detectedEndpoints.length === 0 ||
        candidate.detectedEndpoints.includes("CLAUDE") ||
        candidate.detectedEndpoints.includes("CHAT")
      )
      .sort((a, b) => getClaudeCandidatePriority(a) - getClaudeCandidatePriority(b));

    if (candidates.length === 0) {
      await writeRequestLog({
        requestedModel: modelName,
        isStream: body.stream === true,
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

    const isStream = body.stream === true;
    const anthropicVersion = request.headers.get("anthropic-version") || "2023-06-01";
    const anthropicBeta = request.headers.get("anthropic-beta");
    const effectiveAnthropicBeta = fileRefs.length > 0
      ? anthropicBeta
        ? `${anthropicBeta},files-api-2025-04-14`
        : "files-api-2025-04-14"
      : anthropicBeta;
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    let finalFailureLog: {
      endpointType?: "CLAUDE" | "CHAT";
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
      const baseUrl = normalizeBaseUrl(channel.baseUrl);
      const claudeHeaders: Record<string, string> = {
        "anthropic-version": anthropicVersion,
      };
      if (effectiveAnthropicBeta) {
        claudeHeaders["anthropic-beta"] = effectiveAnthropicBeta;
      }

      const attempts: ClaudeProxyAttempt[] = [];
      if (channel.detectedEndpoints.length === 0 || channel.detectedEndpoints.includes("CLAUDE")) {
        attempts.push({
          endpointType: "CLAUDE",
          url: `${baseUrl}/v1/messages`,
          body: { ...body, model: channel.actualModelName, stream: true },
          apiType: "anthropic",
          extraHeaders: claudeHeaders,
        });
      }
      if (
        allowChatFallback &&
        (channel.detectedEndpoints.length === 0 || channel.detectedEndpoints.includes("CHAT"))
      ) {
        attempts.push({
          endpointType: "CHAT",
          url: `${baseUrl}/v1/chat/completions`,
          body: buildChatBodyFromClaudeRequest(
            { ...body, model: channel.actualModelName, stream: true },
            channel.actualModelName
          ),
          apiType: "openai",
        });
      }

      for (const attempt of attempts) {
        const startedAt = Date.now();

        try {
          const headers = buildUpstreamHeaders(channel.apiKey, attempt.apiType, attempt.extraHeaders);
          const response = await proxyRequest(attempt.url, "POST", headers, attempt.body, channel.proxy);
          const latency = Date.now() - startedAt;

          if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
            lastStatus = response.status;
            addUpstreamAttempt({
              endpointType: attempt.endpointType,
              upstreamPath: getUpstreamPathFromUrl(attempt.url),
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
              endpointType: attempt.endpointType,
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
                endpointType: attempt.endpointType,
                latency,
                statusCode: response.status,
                errorMsg: lastErrorMessage,
              });
            }
            continue;
          }

          addUpstreamAttempt({
            endpointType: attempt.endpointType,
            upstreamPath: getUpstreamPathFromUrl(attempt.url),
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            success: true,
            statusCode: response.status,
            latency,
          });

          if (isStream) {
            const responseModelName = typeof modelName === "string" ? modelName : channel.actualModelName;
            let streamableResponse = response;

            if (attempt.endpointType === "CHAT") {
              const contentType = response.headers.get("content-type") || "";
              if (contentType.includes("text/event-stream")) {
                streamableResponse = convertChatStreamToClaudeStream(response, responseModelName);
              } else {
                const { text, isSse: isSsePayload } = await readUpstreamTextPayload(response);
                const fallbackText = isSsePayload
                  ? extractTextFromChatSse(text)
                  : (() => {
                      try {
                        const data = buildClaudeMessageFromChat(JSON.parse(text), responseModelName);
                        const content = Array.isArray(data.content) ? data.content[0] : null;
                        return content && typeof content === "object" && typeof content.text === "string"
                          ? content.text
                          : text;
                      } catch {
                        return text;
                      }
                    })();
                streamableResponse = createSyntheticClaudeStreamResponse(fallbackText, responseModelName);
              }
            }

            if (isUnifiedRouting && channel.modelId) {
              return streamResponse(streamableResponse, {
                onComplete: () => Promise.all([
                  recordModelResult(channel.modelId!, attempt.endpointType, true, {
                    latency,
                    statusCode: response.status,
                    responseContent: "代理流式请求成功",
                  }),
                  writeRequestLog({
                    endpointType: attempt.endpointType,
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
                  recordModelResult(channel.modelId!, attempt.endpointType, false, {
                    latency,
                    statusCode: 502,
                    errorMsg: "流式传输中断",
                  }),
                  writeRequestLog({
                    endpointType: attempt.endpointType,
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

            return streamResponse(streamableResponse, {
              onComplete: () => writeRequestLog({
                endpointType: attempt.endpointType,
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
                endpointType: attempt.endpointType,
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

          const { text, isSse: isSsePayload } = await readUpstreamTextPayload(response);
          const responseModelName = typeof modelName === "string" ? modelName : channel.actualModelName;
          const data = attempt.endpointType === "CHAT"
            ? (isSsePayload
                ? buildClaudeMessageFromText(responseModelName, extractTextFromChatSse(text))
                : (() => {
                    try {
                      return buildClaudeMessageFromChat(JSON.parse(text), responseModelName);
                    } catch {
                      return buildClaudeMessageFromText(responseModelName, text);
                    }
                  })())
            : (isSsePayload
                ? buildClaudeMessageFromText(responseModelName, extractTextFromClaudeSse(text))
                : JSON.parse(text));

          if (isUnifiedRouting && channel.modelId) {
            await recordModelResult(channel.modelId, attempt.endpointType, true, {
              latency,
              statusCode: response.status,
              responseContent: "代理请求成功",
            });
          }

          await writeRequestLog({
            endpointType: attempt.endpointType,
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
            endpointType: attempt.endpointType,
            upstreamPath: getUpstreamPathFromUrl(attempt.url),
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
            endpointType: attempt.endpointType,
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
              endpointType: attempt.endpointType,
              latency: Date.now() - startedAt,
              statusCode: 502,
              errorMsg: lastErrorMessage,
            });
          }
          continue;
        }
      }
    }

    if (pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordModelResult(failure.modelId, failure.endpointType, false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          })
        )
      );
    }

    await writeRequestLog({
      endpointType: finalFailureLog?.endpointType,
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
