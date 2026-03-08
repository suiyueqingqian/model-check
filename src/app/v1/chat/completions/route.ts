// POST /v1/chat/completions - Proxy OpenAI Chat API
// Supports both streaming and non-streaming responses
// Streaming uses SSE with data: prefix format
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
  recordProxyModelResult,
  streamResponse,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKeyAsync,
} from "@/lib/proxy";

const CLI_DETECT_PROMPT = process.env.DETECT_PROMPT || "1+1=2? yes or no";

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

export async function POST(request: NextRequest) {
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    // Parse request body
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

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "CHAT");
    if (candidates.length === 0) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    const isStream = body.stream === true;
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;

    for (const channel of candidates) {
      const startedAt = Date.now();

      try {
        const upstreamBody = {
          ...body,
          model: channel.actualModelName,
          messages: normalizeMessagesForGeminiCli(body.messages),
        };
        const baseUrl = normalizeBaseUrl(channel.baseUrl);
        const url = `${baseUrl}/v1/chat/completions`;
        const headers = buildUpstreamHeaders(channel.apiKey, "openai");
        const response = await proxyRequest(url, "POST", headers, upstreamBody, channel.proxy);
        const latency = Date.now() - startedAt;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
          lastStatus = response.status;

          if (isUnifiedRouting && channel.modelId) {
            await recordProxyModelResult(channel.modelId, "CHAT", false, {
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            }).catch(() => {});
            continue;
          }

          return errorResponse(lastErrorMessage, lastStatus);
        }

        if (isUnifiedRouting && channel.modelId) {
          await recordProxyModelResult(channel.modelId, "CHAT", true, {
            latency,
            statusCode: response.status,
            responseContent: isStream ? "代理流式请求成功" : "代理请求成功",
          }).catch(() => {});
        }

        if (isStream) {
          return streamResponse(response);
        }

        const data = await response.json();
        return NextResponse.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lastErrorMessage = `Proxy error: ${message}`;
        lastStatus = 502;

        if (isUnifiedRouting && channel.modelId) {
          await recordProxyModelResult(channel.modelId, "CHAT", false, {
            errorMsg: lastErrorMessage,
          }).catch(() => {});
          continue;
        }

        return errorResponse(lastErrorMessage, lastStatus);
      }
    }

    return errorResponse(lastErrorMessage, lastStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
