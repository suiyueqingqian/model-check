// POST /v1/chat/completions - Proxy OpenAI Chat API
// Supports both streaming and non-streaming responses
// Streaming uses SSE with data: prefix format
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
  rememberPreferredProxyEndpoint,
  streamResponse,
  withStreamTracking,
  errorResponse,
  normalizeBaseUrl,
  type ProxyRequestAttemptLog,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import {
  buildChatCompletionFromClaude,
  buildChatCompletionFromGemini,
  buildChatCompletionFromText,
  buildClaudeBodyFromChatRequest,
  buildGeminiBodyFromChatRequest,
  convertClaudeStreamToChatStream,
  createSyntheticChatStreamResponse,
  extractTextFromChatSse,
  extractTextFromClaudeSse,
  extractTextFromGemini,
  extractTextFromResponsesSse,
  isClaudeModelName,
  isGeminiModelName,
  looksLikeSsePayload,
} from "@/lib/proxy/compat";
import {
  getOpenAIEndpointOrder,
  shouldTryResponsesFallbackForChatModel,
  shouldUseResponsesOnlyForChatModel,
} from "@/lib/utils/model-name";
import { createAsyncErrorHandler, isExpectedCloseError, logWarn } from "@/lib/utils/error";
import {
  buildProxyFileBindingKey,
  extractProxyFileReferences,
  getProxyFileBinding,
  type ProxyFileBinding,
} from "@/lib/proxy/file-bindings";

const CLI_DETECT_PROMPT = process.env.DETECT_PROMPT || "1+1=2? yes or no";
const RESPONSES_FALLBACK_HEADERS = {
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

function normalizeMessagesForGeminiCli(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }

    const msg = message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "assistant") {
      return msg;
    }

    // 只在 content 缺失或为空时补上默认值，否则保留用户原始消息
    if (!msg.content) {
      return { ...msg, content: CLI_DETECT_PROMPT };
    }

    return msg;
  });
}

function normalizeResponsesInputContent(content: unknown): Array<{ type: "input_text"; text: string }> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: CLI_DETECT_PROMPT }];
  }

  const parts = content.flatMap((item) => {
    if (typeof item === "string") {
      return [{ type: "input_text" as const, text: item }];
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      return [{ type: "input_text" as const, text: record.text }];
    }

    if (typeof record.content === "string" && record.content.length > 0) {
      return [{ type: "input_text" as const, text: record.content }];
    }

    return [];
  });

  return parts.length > 0 ? parts : [{ type: "input_text", text: CLI_DETECT_PROMPT }];
}

function buildResponsesFallbackBody(
  body: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const {
    messages,
    max_tokens,
    max_completion_tokens,
    stream_options,
    n,
    ...rest
  } = body;

  const fallbackBody: Record<string, unknown> = {
    ...rest,
    model: modelName,
    stream: true,
  };

  if (typeof max_completion_tokens === "number") {
    fallbackBody.max_output_tokens = max_completion_tokens;
  } else if (typeof max_tokens === "number") {
    fallbackBody.max_output_tokens = max_tokens;
  }

  if (Array.isArray(messages)) {
    fallbackBody.input = messages
      .filter((message): message is Record<string, unknown> => !!message && typeof message === "object")
      .map((message) => ({
        role: typeof message.role === "string" ? message.role : "user",
        content: normalizeResponsesInputContent(message.content),
      }));
  }

  if (!("input" in fallbackBody) || fallbackBody.input === undefined) {
    fallbackBody.input = [
      {
        role: "user",
        content: [{ type: "input_text", text: CLI_DETECT_PROMPT }],
      },
    ];
  }

  void stream_options;
  void n;

  return fallbackBody;
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const body = payload as Record<string, unknown>;

  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const contentRecord = part as Record<string, unknown>;
      if (
        contentRecord.type === "output_text" &&
        typeof contentRecord.text === "string"
      ) {
        return contentRecord.text;
      }
    }

    if (typeof record.text === "string") {
      return record.text;
    }
  }

  return "";
}

function buildChatCompletionFromResponses(
  payload: unknown,
  modelName: string
): Record<string, unknown> {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const usage = body.usage && typeof body.usage === "object"
    ? body.usage as Record<string, unknown>
    : null;

  return {
    id: typeof body.id === "string" ? body.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extractResponsesText(payload),
        },
        finish_reason: "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          completion_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          total_tokens: typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : (
                (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
                (typeof usage.output_tokens === "number" ? usage.output_tokens : 0)
              ),
        }
      : undefined,
  };
}

function createChatCompletionChunk(
  modelName: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function convertResponsesStreamToChatStream(
  upstream: Response,
  modelName: string
): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let roleSent = false;
      let emittedText = "";
      let completed = false;

      const sendRole = () => {
        if (roleSent) {
          return;
        }
        roleSent = true;
        controller.enqueue(
          encoder.encode(createChatCompletionChunk(modelName, { role: "assistant" }))
        );
      };

      const sendText = (text: string) => {
        if (!text) {
          return;
        }
        sendRole();
        emittedText += text;
        controller.enqueue(
          encoder.encode(createChatCompletionChunk(modelName, { content: text }))
        );
      };

      const finish = () => {
        if (completed) {
          return;
        }
        completed = true;
        sendRole();
        controller.enqueue(
          encoder.encode(createChatCompletionChunk(modelName, {}, "stop"))
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
            if (!raw || raw === "[DONE]") {
              continue;
            }

            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              if (
                event.type === "response.output_text.delta" &&
                typeof event.delta === "string"
              ) {
                sendText(event.delta);
              } else if (
                event.type === "response.output_text.done" &&
                typeof event.text === "string"
              ) {
                const remaining = event.text.startsWith(emittedText)
                  ? event.text.slice(emittedText.length)
                  : event.text;
                sendText(remaining);
              } else if (event.type === "response.completed") {
                finish();
                return;
              }
            } catch (e) {
              console.warn("[Stream] SSE parse error:", e);
            }
          }
        }

        if (buffer.startsWith("data: ")) {
          const raw = buffer.slice(6).trim();
          if (raw && raw !== "[DONE]") {
            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              if (
                event.type === "response.output_text.done" &&
                typeof event.text === "string"
              ) {
                const remaining = event.text.startsWith(emittedText)
                  ? event.text.slice(emittedText.length)
                  : event.text;
                sendText(remaining);
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
              logWarn("[ChatProxy] 写入转换流失败", controllerError);
            }
          }
        }
      } finally {
        await reader.cancel().catch(createAsyncErrorHandler("[ChatProxy] 关闭转换流失败", "warn"));
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

function buildAttemptList(
  requestedBody: Record<string, unknown>,
  baseUrl: string,
  actualModelName: string,
  detectedEndpoints: string[],
  preferredProxyEndpoint: "CHAT" | "CODEX" | null,
  shouldTryResponsesFallback: boolean
): ProxyAttempt[] {
  if (isClaudeModelName(actualModelName)) {
    return [{
      endpointType: "CLAUDE",
      url: `${baseUrl}/v1/messages`,
      body: buildClaudeBodyFromChatRequest({ ...requestedBody, stream: true }, actualModelName),
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
      body: buildGeminiBodyFromChatRequest(requestedBody),
      apiType: "gemini",
    }];
  }

  const attempts = {
    CHAT: {
      endpointType: "CHAT" as const,
      url: `${baseUrl}/v1/chat/completions`,
      body: {
        ...requestedBody,
        model: actualModelName,
        stream: true,
        messages: normalizeMessagesForGeminiCli(requestedBody.messages),
      },
      apiType: "openai" as const,
    },
    CODEX: {
      endpointType: "CODEX" as const,
      url: `${baseUrl}/v1/responses`,
      body: buildResponsesFallbackBody(requestedBody, actualModelName),
      apiType: "openai" as const,
      extraHeaders: RESPONSES_FALLBACK_HEADERS,
    },
  };

  const allowResponsesFallback =
    shouldTryResponsesFallback ||
    detectedEndpoints.includes("CODEX");

  if (!allowResponsesFallback) {
    return [attempts.CHAT];
  }

  return getOpenAIEndpointOrder({
    modelName: actualModelName,
    requestedEndpoint: "CHAT",
    detectedEndpoints,
    preferredEndpoint: preferredProxyEndpoint,
    allowFallback: true,
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
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const requestId = createProxyRequestId();
    const upstreamAttempts: ProxyRequestAttemptLog[] = [];
    const handleWriteRequestLogError = createAsyncErrorHandler("[ChatProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[ChatProxy] 记录模型结果失败", "warn");
    const handlePreferredEndpointError = createAsyncErrorHandler("[ChatProxy] 记录优先代理端点失败", "warn");
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
      temporaryStopValue: keyResult?.keyRecord?.temporaryStopValue,
      temporaryStopUnit: keyResult?.keyRecord?.temporaryStopUnit,
    }).catch(handleRecordModelResultError);
    const savePreferredProxyEndpoint = (
      ...args: Parameters<typeof rememberPreferredProxyEndpoint>
    ) => rememberPreferredProxyEndpoint(...args).catch(handlePreferredEndpointError);

    // Parse request body
    const body = await request.json();
    const modelName = body.model;
    const fileRefs = Array.from(extractProxyFileReferences(body));

    if (!modelName) {
      await writeRequestLog({
        endpointType: "CHAT",
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
          endpointType: "CHAT",
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
          endpointType: "CHAT",
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
        endpointType: "CHAT",
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: normalizedModelError,
      });
      return errorResponse(normalizedModelError, 400);
    }

    const hasFileRefs = fileRefs.length > 0;

    if (
      hasFileRefs &&
      shouldUseResponsesOnlyForChatModel(routedModelName)
    ) {
      await writeRequestLog({
        endpointType: "CHAT",
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "当前模型带文件时请改用 /v1/responses，不支持经 /v1/chat/completions 兼容转换",
      });
      return errorResponse("当前模型带文件时请改用 /v1/responses，不支持经 /v1/chat/completions 兼容转换", 400);
    }

    if (
      hasFileRefs &&
      (isClaudeModelName(routedModelName) || isGeminiModelName(routedModelName))
    ) {
      await writeRequestLog({
        endpointType: "CHAT",
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "带文件时不支持通过 /v1/chat/completions 转成 Claude 或 Gemini，请改用原生端点",
      });
      return errorResponse("带文件时不支持通过 /v1/chat/completions 转成 Claude 或 Gemini，请改用原生端点", 400);
    }

    const fileBindings = (await Promise.all(fileRefs.map((fileRef) => getProxyFileBinding(fileRef))))
      .filter((binding): binding is ProxyFileBinding => !!binding);
    const boundTargetKey = fileBindings.length > 0 ? buildProxyFileBindingKey(fileBindings[0]) : null;

    if (
      boundTargetKey &&
      fileBindings.some((binding) => buildProxyFileBindingKey(binding) !== boundTargetKey)
    ) {
      await writeRequestLog({
        endpointType: "CHAT",
        requestedModel: modelName,
        isStream: body.stream === true,
        success: false,
        statusCode: 400,
        errorMsg: "请求里混用了不同上游渠道上传的文件，不能一起分析",
      });
      return errorResponse("请求里混用了不同上游渠道上传的文件，不能一起分析", 400);
    }

    const requestedEndpointType =
      isClaudeModelName(routedModelName)
        ? "CLAUDE"
        : isGeminiModelName(routedModelName)
          ? "GEMINI"
          : shouldUseResponsesOnlyForChatModel(routedModelName)
            ? "CODEX"
          : "CHAT";

    const candidateResult = await getProxyChannelCandidatesWithPermission(
      routedModelName,
      keyResult!,
      requestedEndpointType
    );
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
        endpointType: requestedEndpointType,
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
    const shouldTryResponsesFallback = !hasFileRefs && shouldTryResponsesFallbackForChatModel(routedModelName);
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
        shouldTryResponsesFallback
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
          if (attempt.endpointType === "CHAT") {
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

            const { text, isSse } = await readUpstreamTextPayload(response);
            const responseModelName = typeof modelName === "string" ? modelName : channel.actualModelName;
            const data = isSse ? buildChatCompletionFromText(responseModelName, extractTextFromChatSse(text)) : JSON.parse(text);

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
              const convertedResponse = convertClaudeStreamToChatStream(response, modelName);

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

            const { text, isSse } = await readUpstreamTextPayload(response);
            const responseModelName = typeof modelName === "string" ? modelName : channel.actualModelName;
            const convertedPayload = isSse
              ? buildChatCompletionFromText(responseModelName, extractTextFromClaudeSse(text))
              : buildChatCompletionFromClaude(JSON.parse(text), responseModelName);

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
              const convertedResponse = createSyntheticChatStreamResponse(geminiText, modelName);

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

            const convertedPayload = buildChatCompletionFromGemini(data, modelName);

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
            const convertedResponse = convertResponsesStreamToChatStream(response, modelName);

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

          const { text, isSse } = await readUpstreamTextPayload(response);
          const responseModelName = typeof modelName === "string" ? modelName : channel.actualModelName;
          const convertedPayload = isSse
            ? buildChatCompletionFromText(responseModelName, extractTextFromResponsesSse(text))
            : buildChatCompletionFromResponses(JSON.parse(text), responseModelName);

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
      endpointType: finalFailureLog?.endpointType ?? "CHAT",
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
