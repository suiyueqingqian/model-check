// POST /v1/messages - Proxy Anthropic Claude Messages API
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  findChannelByModel,
  buildUpstreamHeaders,
  proxyRequest,
  streamResponse,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKey,
} from "@/lib/proxy";

export async function POST(request: NextRequest) {
  // Verify proxy API key
  const authError = verifyProxyKey(request);
  if (authError) return authError;

  try {
    // Parse request body
    const body = await request.json();
    const modelName = body.model;

    if (!modelName) {
      return errorResponse("Missing 'model' field in request body", 400);
    }

    // Find channel by model name
    const channel = await findChannelByModel(modelName);
    if (!channel) {
      return errorResponse(`Model not found: ${modelName}`, 404);
    }

    const isStream = body.stream === true;
    const baseUrl = normalizeBaseUrl(channel.baseUrl);
    const url = `${baseUrl}/v1/messages`;

    // Get anthropic-version from request or use default
    const anthropicVersion =
      request.headers.get("anthropic-version") || "2023-06-01";
    const headers = buildUpstreamHeaders(channel.apiKey, "anthropic", {
      "anthropic-version": anthropicVersion,
    });

    console.log(`[Proxy] Claude request for model "${modelName}" -> channel "${channel.channelName}"`);

    // Forward request to upstream (with channel proxy support)
    const response = await proxyRequest(url, "POST", headers, body, channel.proxy);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return errorResponse(
        `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`,
        response.status
      );
    }

    // Handle streaming response
    if (isStream) {
      return streamResponse(response);
    }

    // Handle non-streaming response
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[Proxy /v1/messages] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
