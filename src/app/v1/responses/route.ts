// POST /v1/responses - Proxy OpenAI Responses API (2025)
// Supports both streaming and non-streaming responses
// Streaming uses SSE with event types: response.created, response.output_text.delta, response.completed
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
  recordProxyModelResult,
  rememberPreferredProxyEndpoint,
  streamResponse,
  withStreamTracking,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import { isGptFiveOrNewerModel } from "@/lib/utils/model-name";

const CLI_DETECT_PROMPT = process.env.DETECT_PROMPT || "1+1=2? yes or no";
const RESPONSES_HEADERS = {
  "User-Agent": "codex_cli_rs/0.0.1",
  originator: "codex_cli_rs",
};

type ProxyAttemptFailure = {
  modelId: string;
  endpointType: "CHAT" | "CODEX";
  latency?: number;
  statusCode?: number;
  errorMsg: string;
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
          } catch {
            // controller already closed
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
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
  preferredProxyEndpoint: "CHAT" | "CODEX" | null,
  shouldTryChatFallback: boolean
): Array<{
  endpointType: "CHAT" | "CODEX";
  url: string;
  body: Record<string, unknown>;
}> {
  const attempts = {
    CHAT: {
      endpointType: "CHAT" as const,
      url: `${baseUrl}/v1/chat/completions`,
      body: buildChatFallbackBody(requestedBody, actualModelName),
    },
    CODEX: {
      endpointType: "CODEX" as const,
      url: `${baseUrl}/v1/responses`,
      body: { ...requestedBody, model: actualModelName, stream: requestedBody.stream !== false },
    },
  };

  if (!shouldTryChatFallback) {
    return [attempts.CODEX];
  }

  if (preferredProxyEndpoint === "CHAT") {
    return [attempts.CHAT, attempts.CODEX];
  }

  return [attempts.CODEX, attempts.CHAT];
}

async function requestUpstreamAttempt(
  channel: {
    apiKey: string;
    proxy: string | null;
  },
  attempt: {
    endpointType: "CHAT" | "CODEX";
    url: string;
    body: Record<string, unknown>;
  }
): Promise<
  | { ok: true; data: ProxyAttemptSuccess }
  | { ok: false; data: { latency: number; statusCode: number; errorMsg: string } }
> {
  const startedAt = Date.now();

  try {
    const headers = buildUpstreamHeaders(
      channel.apiKey,
      "openai",
      attempt.endpointType === "CODEX" ? RESPONSES_HEADERS : undefined
    );
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
    const body = await request.json();
    const modelName = body.model;

    if (!modelName) {
      return errorResponse("Missing 'model' field in request body", 400);
    }

    const isUnifiedMode = keyResult?.keyRecord?.unifiedMode === true;
    if (!isUnifiedMode) {
      if (typeof modelName !== "string" || modelName.indexOf("/") <= 0 || modelName.endsWith("/")) {
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (typeof modelName !== "string" || modelName.trim().length === 0) {
        return errorResponse("Missing or invalid 'model' field", 400);
      }
    }

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "CODEX");
    if (candidates.length === 0) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    const isStream = body.stream !== false;
    const shouldTryChatFallback =
      isGptFiveOrNewerModel(modelName) &&
      !modelName.toLowerCase().includes("codex");
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    const pendingFailures: ProxyAttemptFailure[] = [];

    for (const channel of candidates) {
      const attempts = buildAttemptList(
        body,
        normalizeBaseUrl(channel.baseUrl),
        channel.actualModelName,
        channel.preferredProxyEndpoint,
        shouldTryChatFallback
      );

      for (const attempt of attempts) {
        const result = await requestUpstreamAttempt(channel, attempt);

        if (!result.ok) {
          lastErrorMessage = result.data.errorMsg;
          lastStatus = result.data.statusCode;

          if (channel.modelId) {
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

        try {
          if (attempt.endpointType === "CODEX") {
            if (isStream) {
              if (isUnifiedRouting && channel.modelId) {
                return streamResponse(response, {
                  onComplete: () => recordProxyModelResult(channel.modelId!, attempt.endpointType, true, {
                    channelId: channel.channelId,
                    modelName: channel.actualModelName,
                    latency,
                    statusCode: response.status,
                    responseContent: "代理流式请求成功",
                  }).catch(() => {}),
                  onError: () => recordProxyModelResult(channel.modelId!, attempt.endpointType, false, {
                    channelId: channel.channelId,
                    modelName: channel.actualModelName,
                    latency,
                    statusCode: 502,
                    errorMsg: "流式传输中断",
                  }).catch(() => {}),
                });
              }

              if (channel.modelId) {
                return streamResponse(response, {
                  onComplete: () => rememberPreferredProxyEndpoint(
                    channel.modelId!,
                    attempt.endpointType
                  ).catch(() => {}),
                  onError: () => recordProxyModelResult(channel.modelId!, attempt.endpointType, false, {
                    latency,
                    statusCode: 502,
                    errorMsg: "流式传输中断",
                  }).catch(() => {}),
                });
              }

              return streamResponse(response);
            }

            const data = await response.json();

            if (channel.modelId && !isUnifiedRouting) {
              await rememberPreferredProxyEndpoint(
                channel.modelId,
                attempt.endpointType
              ).catch(() => {});
            }

            if (isUnifiedRouting && channel.modelId) {
              await recordProxyModelResult(channel.modelId, attempt.endpointType, true, {
                channelId: channel.channelId,
                modelName: channel.actualModelName,
                latency,
                statusCode: response.status,
                responseContent: "代理请求成功",
              }).catch(() => {});
            }

            return NextResponse.json(data);
          }

          if (isStream) {
            const convertedResponse = convertChatStreamToResponsesStream(response, modelName);

            if (isUnifiedRouting && channel.modelId) {
              return withStreamTracking(convertedResponse,
                () => recordProxyModelResult(channel.modelId!, attempt.endpointType, true, {
                  channelId: channel.channelId,
                  modelName: channel.actualModelName,
                  latency,
                  statusCode: response.status,
                  responseContent: "代理流式请求成功",
                }).catch(() => {}),
                () => recordProxyModelResult(channel.modelId!, attempt.endpointType, false, {
                  channelId: channel.channelId,
                  modelName: channel.actualModelName,
                  latency,
                  statusCode: 502,
                  errorMsg: "流式传输中断",
                }).catch(() => {}),
              );
            }

            if (channel.modelId) {
              return withStreamTracking(
                convertedResponse,
                () => rememberPreferredProxyEndpoint(
                  channel.modelId!,
                  attempt.endpointType
                ).catch(() => {}),
                () => recordProxyModelResult(channel.modelId!, attempt.endpointType, false, {
                  latency,
                  statusCode: 502,
                  errorMsg: "流式传输中断",
                }).catch(() => {})
              );
            }

            return convertedResponse;
          }

          const data = await response.json();
          const convertedPayload = buildResponsesFromChatCompletion(data, modelName);

          if (channel.modelId && !isUnifiedRouting) {
            await rememberPreferredProxyEndpoint(
              channel.modelId,
              attempt.endpointType
            ).catch(() => {});
          }

          if (isUnifiedRouting && channel.modelId) {
            await recordProxyModelResult(channel.modelId, attempt.endpointType, true, {
              channelId: channel.channelId,
              modelName: channel.actualModelName,
              latency,
              statusCode: response.status,
              responseContent: "代理请求成功",
            }).catch(() => {});
          }

          return NextResponse.json(convertedPayload);
        } catch (error) {
          lastErrorMessage = `Proxy error: ${error instanceof Error ? error.message : "Unknown error"}`;
          lastStatus = 502;

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
          recordProxyModelResult(failure.modelId, failure.endpointType, false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          }).catch(() => {})
        )
      );
    }

    return errorResponse(lastErrorMessage, lastStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
