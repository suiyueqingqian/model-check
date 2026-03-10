// POST /v1/responses - Proxy OpenAI Responses API (2025)
// Supports both streaming and non-streaming responses
// Streaming uses SSE with event types: response.created, response.output_text.delta, response.completed
// Automatically routes to the correct channel based on model name

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
  rememberPreferredProxyEndpoint,
  streamResponse,
  withStreamTracking,
  errorResponse,
  normalizeBaseUrl,
  type ProxyRequestAttemptLog,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import {
  buildClaudeBodyFromResponsesRequest,
  buildGeminiBodyFromResponsesRequest,
  buildResponsesFromClaude,
  buildResponsesFromGemini,
  convertClaudeStreamToResponsesStream,
  createSyntheticResponsesStreamResponse,
  extractTextFromGemini,
  isClaudeModelName,
  isGeminiModelName,
} from "@/lib/proxy/compat";
import {
  getOpenAIEndpointOrder,
  isGptFiveOrNewerModel,
  shouldUseChatCompletionsOnlyForModel,
} from "@/lib/utils/model-name";
import { createAsyncErrorHandler, isExpectedCloseError, logWarn } from "@/lib/utils/error";

const CLI_DETECT_PROMPT = process.env.DETECT_PROMPT || "1+1=2? yes or no";
const RESPONSES_HEADERS = {
  "User-Agent": "codex_cli_rs/0.0.1",
  originator: "codex_cli_rs",
};

type ProxyAttemptFailure = {
  modelId: string;
  endpointType: "CHAT" | "CODEX" | "CLAUDE" | "GEMINI";
  latency?: number;
  statusCode?: number;
  errorMsg: string;
};

type ProxyAttemptApiType = "openai" | "anthropic" | "gemini";

type ProxyAttempt = {
  endpointType: "CHAT" | "CODEX" | "CLAUDE" | "GEMINI";
  url: string;
  body: Record<string, unknown>;
  apiType: ProxyAttemptApiType;
  extraHeaders?: Record<string, string>;
};

type ProxyAttemptSuccess = {
  response: Response;
  latency: number;
};

function normalizeChatMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return CLI_DETECT_PROMPT;
  }

  const parts = content.flatMap((item) => {
    if (typeof item === "string") {
      return item;
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }

    if (typeof record.content === "string" && record.content.length > 0) {
      return record.content;
    }

    return [];
  });

  return parts.length > 0 ? parts.join("\n") : CLI_DETECT_PROMPT;
}

function buildChatMessagesFromResponsesInput(input: unknown): Array<{ role: string; content: string }> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: CLI_DETECT_PROMPT }];
  }

  const messages = input
    .filter((message): message is Record<string, unknown> => !!message && typeof message === "object")
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "user",
      content: normalizeChatMessageContent(message.content),
    }))
    .filter((message) => message.content.trim().length > 0);

  return messages.length > 0 ? messages : [{ role: "user", content: CLI_DETECT_PROMPT }];
}

function buildChatFallbackBody(
  body: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const {
    input,
    max_output_tokens,
    previous_response_id,
    prompt,
    include,
    truncation,
    text,
    ...rest
  } = body;

  const fallbackBody: Record<string, unknown> = {
    ...rest,
    model: modelName,
    stream: body.stream !== false,
    messages: buildChatMessagesFromResponsesInput(input),
  };

  if (typeof max_output_tokens === "number") {
    fallbackBody.max_completion_tokens = max_output_tokens;
  }

  void previous_response_id;
  void prompt;
  void include;
  void truncation;
  void text;

  return fallbackBody;
}

function hasResponsesOnlyFields(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return true;
  }

  if ("reasoning" in body || "text" in body) {
    return true;
  }

  if (
    "previous_response_id" in body ||
    "include" in body ||
    "truncation" in body
  ) {
    return true;
  }

  return false;
}

function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const body = payload as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message;
  if (message && typeof message === "object") {
    const messageRecord = message as Record<string, unknown>;
    if (typeof messageRecord.content === "string") {
      return messageRecord.content;
    }
  }

  if (typeof choice.text === "string") {
    return choice.text;
  }

  return "";
}

function buildResponsesFromChatCompletion(
  payload: unknown,
  modelName: string
): Record<string, unknown> {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const id = typeof body.id === "string" ? body.id : `resp_${Date.now()}`;
  const outputText = extractChatText(payload);
  const usage = body.usage && typeof body.usage === "object"
    ? body.usage as Record<string, unknown>
    : null;

  return {
    id,
    object: "response",
    created_at: new Date().toISOString(),
    model: modelName,
    status: "completed",
    output: [
      {
        id: `${id}_output_0`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    usage: usage
      ? {
          input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
          total_tokens: typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : (
                (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
                (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0)
              ),
        }
      : undefined,
  };
}

function createResponsesEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function convertChatStreamToResponsesStream(
  upstream: Response,
  modelName: string
): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `resp_${Date.now()}`;
  const outputItemId = `${responseId}_output_0`;

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let emittedText = "";
      let created = false;
      let completed = false;

      const sendCreated = () => {
        if (created) {
          return;
        }
        created = true;
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                created_at: new Date().toISOString(),
                model: modelName,
                status: "in_progress",
                output: [],
              },
            })
          )
        );
      };

      const sendDelta = (delta: string) => {
        if (!delta) {
          return;
        }
        sendCreated();
        emittedText += delta;
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.output_text.delta",
              item_id: outputItemId,
              output_index: 0,
              content_index: 0,
              delta,
            })
          )
        );
      };

      const finish = () => {
        if (completed) {
          return;
        }
        completed = true;
        sendCreated();
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.output_text.done",
              item_id: outputItemId,
              output_index: 0,
              content_index: 0,
              text: emittedText,
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                created_at: new Date().toISOString(),
                model: modelName,
                status: "completed",
                output: [
                  {
                    id: outputItemId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: emittedText,
                        annotations: [],
                      },
                    ],
                  },
                ],
                output_text: emittedText,
              },
            })
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }

            const raw = line.slice(6).trim();
            if (!raw) {
              continue;
            }

            if (raw === "[DONE]") {
              finish();
              return;
            }

            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              const delta = event.choices &&
                Array.isArray(event.choices) &&
                event.choices[0] &&
                typeof event.choices[0] === "object"
                ? (event.choices[0] as Record<string, unknown>).delta
                : null;

              if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string") {
                sendDelta((delta as Record<string, unknown>).content as string);
              }
            } catch (e) {
              console.warn("[Stream] SSE parse error:", e);
            }
          }
        }

        finish();
      } catch (e) {
        if (!completed) {
          try {
            controller.error(e instanceof Error ? e : new Error("Stream interrupted"));
          } catch (controllerError) {
            if (!isExpectedCloseError(controllerError)) {
              logWarn("[ResponsesProxy] 写入转换流失败", controllerError);
            }
          }
        }
      } finally {
        await reader.cancel().catch(createAsyncErrorHandler("[ResponsesProxy] 关闭转换流失败", "warn"));
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function buildAttemptList(
  requestedBody: Record<string, unknown>,
  baseUrl: string,
  actualModelName: string,
  detectedEndpoints: string[],
  preferredProxyEndpoint: "CHAT" | "CODEX" | null,
  shouldTryChatFallback: boolean,
  forceChatCompletions: boolean
): ProxyAttempt[] {
  if (isClaudeModelName(actualModelName)) {
    return [{
      endpointType: "CLAUDE",
      url: `${baseUrl}/v1/messages`,
      body: buildClaudeBodyFromResponsesRequest(requestedBody, actualModelName),
      apiType: "anthropic",
    }];
  }

  if (isGeminiModelName(actualModelName)) {
    const geminiBaseUrl = baseUrl.endsWith("/v1beta")
      ? baseUrl.slice(0, -7)
      : baseUrl;
    return [{
      endpointType: "GEMINI",
      url: `${geminiBaseUrl}/v1beta/models/${actualModelName}:generateContent`,
      body: buildGeminiBodyFromResponsesRequest(requestedBody),
      apiType: "gemini",
    }];
  }

  const attempts = {
    CHAT: {
      endpointType: "CHAT" as const,
      url: `${baseUrl}/v1/chat/completions`,
      body: buildChatFallbackBody(requestedBody, actualModelName),
      apiType: "openai" as const,
    },
    CODEX: {
      endpointType: "CODEX" as const,
      url: `${baseUrl}/v1/responses`,
      body: { ...requestedBody, model: actualModelName, stream: requestedBody.stream !== false },
      apiType: "openai" as const,
      extraHeaders: RESPONSES_HEADERS,
    },
  };

  if (forceChatCompletions) {
    return [attempts.CHAT];
  }

  if (!shouldTryChatFallback) {
    return [attempts.CODEX];
  }

  return getOpenAIEndpointOrder({
    modelName: actualModelName,
    requestedEndpoint: "CODEX",
    detectedEndpoints,
    preferredEndpoint: preferredProxyEndpoint,
    allowFallback: true,
    forceRequestedFirst: hasResponsesOnlyFields(requestedBody),
  }).map((endpoint) => attempts[endpoint]);
}

async function requestUpstreamAttempt(
  channel: {
    apiKey: string;
    proxy: string | null;
  },
  attempt: ProxyAttempt
): Promise<
  | { ok: true; data: ProxyAttemptSuccess }
  | { ok: false; data: { latency: number; statusCode: number; errorMsg: string } }
> {
  const startedAt = Date.now();

  try {
    const headers = buildUpstreamHeaders(channel.apiKey, attempt.apiType, attempt.extraHeaders);
    const response = await proxyRequest(
      attempt.url,
      "POST",
      headers,
      attempt.body,
      channel.proxy
    );
    const latency = Date.now() - startedAt;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return {
        ok: false,
        data: {
          latency,
          statusCode: response.status,
          errorMsg: `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        response,
        latency,
      },
    };
  } catch (error) {
    return {
      ok: false,
      data: {
        latency: Date.now() - startedAt,
        statusCode: 502,
        errorMsg: `Proxy error: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
    };
  }
}

export async function POST(request: NextRequest) {
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const requestId = createProxyRequestId();
    const upstreamAttempts: ProxyRequestAttemptLog[] = [];
    const handleWriteRequestLogError = createAsyncErrorHandler("[ResponsesProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[ResponsesProxy] 记录模型结果失败", "warn");
    const handlePreferredEndpointError = createAsyncErrorHandler("[ResponsesProxy] 记录优先代理端点失败", "warn");
    const writeRequestLog = (options: {
      endpointType?: "CHAT" | "CODEX" | "CLAUDE" | "GEMINI";
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
      proxyKeyId: keyResult?.keyRecord?.id,
      temporaryStopValue: keyResult?.keyRecord?.temporaryStopValue,
      temporaryStopUnit: keyResult?.keyRecord?.temporaryStopUnit,
    }).catch(handleRecordModelResultError);
    const savePreferredProxyEndpoint = (
      ...args: Parameters<typeof rememberPreferredProxyEndpoint>
    ) => rememberPreferredProxyEndpoint(...args).catch(handlePreferredEndpointError);

    const body = await request.json();
    const modelName = body.model;

    if (!modelName) {
      await writeRequestLog({
        endpointType: "CODEX",
        requestedModel: null,
        isStream: body.stream !== false,
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
          endpointType: "CODEX",
          requestedModel: typeof modelName === "string" ? modelName : null,
          isStream: body.stream !== false,
          success: false,
          statusCode: 400,
          errorMsg: "Model must use channel prefix format: channelName/modelName",
        });
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (typeof modelName !== "string" || modelName.trim().length === 0) {
        await writeRequestLog({
          endpointType: "CODEX",
          requestedModel: typeof modelName === "string" ? modelName : null,
          isStream: body.stream !== false,
          success: false,
          statusCode: 400,
          errorMsg: "Missing or invalid 'model' field",
        });
        return errorResponse("Missing or invalid 'model' field", 400);
      }
    }

    const forceChatCompletions =
      typeof modelName === "string" && shouldUseChatCompletionsOnlyForModel(modelName);

    const requestedEndpointType =
      typeof modelName === "string" && isClaudeModelName(modelName)
        ? "CLAUDE"
        : typeof modelName === "string" && isGeminiModelName(modelName)
          ? "GEMINI"
          : forceChatCompletions
            ? "CHAT"
          : "CODEX";

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(
      modelName,
      keyResult!,
      requestedEndpointType
    );
    if (candidates.length === 0) {
      await writeRequestLog({
        endpointType: requestedEndpointType,
        requestedModel: modelName,
        isStream: body.stream !== false,
        success: false,
        statusCode: 404,
        errorMsg: `Model not found or access denied: ${modelName}`,
      });
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    const isStream = body.stream !== false;
    const shouldTryChatFallback =
      forceChatCompletions ||
      (
        isGptFiveOrNewerModel(modelName) &&
        !modelName.toLowerCase().includes("codex")
      );
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    let finalFailureLog: {
      endpointType?: "CHAT" | "CODEX" | "CLAUDE" | "GEMINI";
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
      const attempts = buildAttemptList(
        body,
        normalizeBaseUrl(channel.baseUrl),
        channel.actualModelName,
        channel.detectedEndpoints,
        channel.preferredProxyEndpoint,
        shouldTryChatFallback,
        forceChatCompletions
      );

      for (const attempt of attempts) {
        const result = await requestUpstreamAttempt(channel, attempt);

        if (!result.ok) {
          addUpstreamAttempt({
            endpointType: attempt.endpointType,
            upstreamPath: getUpstreamPathFromUrl(attempt.url),
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            success: false,
            statusCode: result.data.statusCode,
            latency: result.data.latency,
            errorMsg: result.data.errorMsg,
          });
          lastErrorMessage = result.data.errorMsg;
          lastStatus = result.data.statusCode;
          finalFailureLog = {
            endpointType: attempt.endpointType,
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: result.data.statusCode,
            latency: result.data.latency,
            errorMsg: result.data.errorMsg,
          };

          if (channel.modelId) {
            await markProxyChannelKeyUnavailable(channel.modelId, result.data.statusCode, result.data.errorMsg);
            pendingFailures.push({
              modelId: channel.modelId,
              endpointType: attempt.endpointType,
              latency: result.data.latency,
              statusCode: result.data.statusCode,
              errorMsg: result.data.errorMsg,
            });
          }

          continue;
        }

        const { response, latency } = result.data;
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

        try {
          if (attempt.endpointType === "CODEX") {
            if (isStream) {
              if (isUnifiedRouting && channel.modelId) {
                return streamResponse(response, {
                  onComplete: () => Promise.all([
                    recordModelResult(channel.modelId!, attempt.endpointType, true, {
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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

              if (channel.modelId) {
                return streamResponse(response, {
                  onComplete: () => Promise.all([
                    rememberPreferredProxyEndpoint(
                      channel.modelId!,
                      attempt.endpointType as "CHAT" | "CODEX"
                    ).catch(handlePreferredEndpointError),
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

              return streamResponse(response, {
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

            const data = await response.json();

            if (channel.modelId && !isUnifiedRouting) {
              await savePreferredProxyEndpoint(
                channel.modelId,
                attempt.endpointType as "CHAT" | "CODEX"
              );
            }

            if (isUnifiedRouting && channel.modelId) {
              await recordModelResult(channel.modelId, attempt.endpointType, true, {
                channelId: channel.channelId,
                modelName: channel.actualModelName,
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
          }

          if (attempt.endpointType === "CLAUDE") {
            if (isStream) {
              const convertedResponse = convertClaudeStreamToResponsesStream(response, modelName);

              if (isUnifiedRouting && channel.modelId) {
                return withStreamTracking(
                  convertedResponse,
                  () => Promise.all([
                    recordModelResult(channel.modelId!, attempt.endpointType, true, {
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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
                  () => Promise.all([
                    recordModelResult(channel.modelId!, attempt.endpointType, false, {
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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
                  ]).then(() => {})
                );
              }

              return withStreamTracking(
                convertedResponse,
                () => writeRequestLog({
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
                () => writeRequestLog({
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
                })
              );
            }

            const data = await response.json();
            const convertedPayload = buildResponsesFromClaude(data, modelName);

            if (isUnifiedRouting && channel.modelId) {
              await recordModelResult(channel.modelId, attempt.endpointType, true, {
                channelId: channel.channelId,
                modelName: channel.actualModelName,
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

            return NextResponse.json(convertedPayload);
          }

          if (attempt.endpointType === "GEMINI") {
            const data = await response.json();
            const geminiText = extractTextFromGemini(data);

            if (isStream) {
              const convertedResponse = createSyntheticResponsesStreamResponse(geminiText, modelName);

              if (isUnifiedRouting && channel.modelId) {
                return withStreamTracking(
                  convertedResponse,
                  () => Promise.all([
                    recordModelResult(channel.modelId!, attempt.endpointType, true, {
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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
                  () => Promise.all([
                    recordModelResult(channel.modelId!, attempt.endpointType, false, {
                      channelId: channel.channelId,
                      modelName: channel.actualModelName,
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
                  ]).then(() => {})
                );
              }

              return withStreamTracking(
                convertedResponse,
                () => writeRequestLog({
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
                () => writeRequestLog({
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
                })
              );
            }

            const convertedPayload = buildResponsesFromGemini(data, modelName);

            if (isUnifiedRouting && channel.modelId) {
              await recordModelResult(channel.modelId, attempt.endpointType, true, {
                channelId: channel.channelId,
                modelName: channel.actualModelName,
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

            return NextResponse.json(convertedPayload);
          }

          if (isStream) {
            const convertedResponse = convertChatStreamToResponsesStream(response, modelName);

            if (isUnifiedRouting && channel.modelId) {
              return withStreamTracking(convertedResponse,
                () => Promise.all([
                  recordModelResult(channel.modelId!, attempt.endpointType, true, {
                    channelId: channel.channelId,
                    modelName: channel.actualModelName,
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
                () => Promise.all([
                  recordModelResult(channel.modelId!, attempt.endpointType, false, {
                    channelId: channel.channelId,
                    modelName: channel.actualModelName,
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
              );
            }

            if (channel.modelId) {
              return withStreamTracking(
                convertedResponse,
                () => Promise.all([
                  rememberPreferredProxyEndpoint(
                    channel.modelId!,
                    attempt.endpointType as "CHAT" | "CODEX"
                  ).catch(handlePreferredEndpointError),
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
                () => Promise.all([
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
                ]).then(() => {})
              );
            }

            return withStreamTracking(
              convertedResponse,
              () => writeRequestLog({
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
              () => writeRequestLog({
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
              })
            );
          }

          const data = await response.json();
          const convertedPayload = buildResponsesFromChatCompletion(data, modelName);

          if (channel.modelId && !isUnifiedRouting) {
            await savePreferredProxyEndpoint(
              channel.modelId,
              attempt.endpointType as "CHAT" | "CODEX"
            );
          }

          if (isUnifiedRouting && channel.modelId) {
            await recordModelResult(channel.modelId, attempt.endpointType, true, {
              channelId: channel.channelId,
              modelName: channel.actualModelName,
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

          return NextResponse.json(convertedPayload);
        } catch (error) {
          lastErrorMessage = `Proxy error: ${error instanceof Error ? error.message : "Unknown error"}`;
          lastStatus = 502;
          finalFailureLog = {
            endpointType: attempt.endpointType,
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: 502,
            latency,
            errorMsg: lastErrorMessage,
          };

          upstreamAttempts[upstreamAttempts.length - 1] = {
            ...upstreamAttempts[upstreamAttempts.length - 1],
            success: false,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          };

          if (channel.modelId) {
            pendingFailures.push({
              modelId: channel.modelId,
              endpointType: attempt.endpointType,
              latency,
              statusCode: 502,
              errorMsg: lastErrorMessage,
            });
          }
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
      endpointType: finalFailureLog?.endpointType ?? "CODEX",
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
