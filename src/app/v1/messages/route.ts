// POST /v1/messages - Proxy Anthropic Claude Messages API
// Supports both streaming and non-streaming responses
// Streaming uses SSE with event types: message_start, content_block_delta, message_stop
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  findChannelByModelWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
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

    if (typeof modelName !== "string" || modelName.indexOf("/") <= 0 || modelName.endsWith("/")) {
      return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
    }

    // Find channel by model name with permission check (requires "channelName/modelName" format)
    const channel = await findChannelByModelWithPermission(modelName, keyResult!);
    if (!channel) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    // Use actual model name (without channel prefix) for upstream request
    const upstreamBody = { ...body, model: channel.actualModelName };

    const isStream = body.stream === true;
    const baseUrl = normalizeBaseUrl(channel.baseUrl);
    const url = `${baseUrl}/v1/messages`;

    // Get anthropic-version from request or use default
    // Also forward anthropic-beta header for features like code-execution, extended-thinking
    const anthropicVersion = request.headers.get("anthropic-version") || "2023-06-01";
    const anthropicBeta = request.headers.get("anthropic-beta");

    const extraHeaders: Record<string, string> = {
      "anthropic-version": anthropicVersion,
    };
    if (anthropicBeta) {
      extraHeaders["anthropic-beta"] = anthropicBeta;
    }

    const headers = buildUpstreamHeaders(channel.apiKey, "anthropic", extraHeaders);

    // Forward request to upstream (with channel proxy support)
    const response = await proxyRequest(url, "POST", headers, upstreamBody, channel.proxy);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return errorResponse(
        `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`,
        response.status
      );
    }

    // Handle streaming response (SSE format)
    if (isStream) {
      return streamResponse(response);
    }

    // Handle non-streaming response
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
