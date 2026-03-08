// POST /v1/messages - Proxy Anthropic Claude Messages API
// Supports both streaming and non-streaming responses
// Streaming uses SSE with event types: message_start, content_block_delta, message_stop
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

    const { isUnifiedRouting, candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "CLAUDE");
    if (candidates.length === 0) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    const isStream = body.stream === true;
    const anthropicVersion = request.headers.get("anthropic-version") || "2023-06-01";
    const anthropicBeta = request.headers.get("anthropic-beta");
    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;

    for (const channel of candidates) {
      const startedAt = Date.now();

      try {
        const upstreamBody = { ...body, model: channel.actualModelName };
        const baseUrl = normalizeBaseUrl(channel.baseUrl);
        const url = `${baseUrl}/v1/messages`;
        const extraHeaders: Record<string, string> = {
          "anthropic-version": anthropicVersion,
        };
        if (anthropicBeta) {
          extraHeaders["anthropic-beta"] = anthropicBeta;
        }

        const headers = buildUpstreamHeaders(channel.apiKey, "anthropic", extraHeaders);
        const response = await proxyRequest(url, "POST", headers, upstreamBody, channel.proxy);
        const latency = Date.now() - startedAt;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
          lastStatus = response.status;

          if (isUnifiedRouting && channel.modelId) {
            await recordProxyModelResult(channel.modelId, "CLAUDE", false, {
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            }).catch(() => {});
            continue;
          }

          return errorResponse(lastErrorMessage, lastStatus);
        }

        if (isUnifiedRouting && channel.modelId) {
          await recordProxyModelResult(channel.modelId, "CLAUDE", true, {
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
          await recordProxyModelResult(channel.modelId, "CLAUDE", false, {
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
