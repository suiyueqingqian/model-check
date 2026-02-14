// POST /v1beta/models/[...path] - Proxy Google Gemini API
// Handles:
//   - POST /v1beta/models/{model}:generateContent
//   - POST /v1beta/models/{model}:streamGenerateContent
// Automatically routes to the correct channel based on model name in path

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
    // Reconstruct the path from catch-all segments
    const { path } = await params;
    const pathStr = path.join("/");

    // Extract model name from path (e.g., "gemini-1.5-flash:generateContent" -> "gemini-1.5-flash")
    const colonIndex = pathStr.indexOf(":");
    if (colonIndex === -1) {
      return errorResponse(
        "Invalid path format. Expected: /v1beta/models/{model}:{method}",
        400
      );
    }

    const modelName = pathStr.substring(0, colonIndex);
    const method = pathStr.substring(colonIndex + 1);

    if (!isPrefixedModelName(modelName)) {
      return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
    }

    // Find channel by model name with permission check
    const channel = await findChannelByModelWithPermission(modelName, keyResult!);
    if (!channel) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    // Parse request body
    const body = await request.json();

    // Determine if this is a streaming request
    const isStream = method === "streamGenerateContent";

    // Normalize baseUrl - remove trailing /v1beta if present
    let baseUrl = normalizeBaseUrl(channel.baseUrl);
    if (baseUrl.endsWith("/v1beta")) {
      baseUrl = baseUrl.slice(0, -7);
    }

    const upstreamModelPath = `${channel.actualModelName}:${method}`;
    const url = `${baseUrl}/v1beta/models/${upstreamModelPath}`;
    const headers = buildUpstreamHeaders(channel.apiKey, "gemini");

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
    const { path } = await params;
    const modelName = path.join("/");

    if (!isPrefixedModelName(modelName)) {
      return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
    }

    // Find channel by model name with permission check
    const channel = await findChannelByModelWithPermission(modelName, keyResult!);
    if (!channel) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    // Normalize baseUrl
    let baseUrl = normalizeBaseUrl(channel.baseUrl);
    if (baseUrl.endsWith("/v1beta")) {
      baseUrl = baseUrl.slice(0, -7);
    }

    const url = `${baseUrl}/v1beta/models/${channel.actualModelName}`;
    const headers = buildUpstreamHeaders(channel.apiKey, "gemini");

    // Forward request to upstream (with channel proxy support)
    const response = await proxyRequest(url, "GET", headers, undefined, channel.proxy);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return errorResponse(
        `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`,
        response.status
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
