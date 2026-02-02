// POST /v1beta/models/[...path] - Proxy Google Gemini API
// Handles:
//   - POST /v1beta/models/{model}:generateContent
//   - POST /v1beta/models/{model}:streamGenerateContent
// Automatically routes to the correct channel based on model name in path

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Verify proxy API key
  const authError = verifyProxyKey(request);
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

    // Find channel by model name
    const channel = await findChannelByModel(modelName);
    if (!channel) {
      return errorResponse(`Model not found: ${modelName}`, 404);
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

    const url = `${baseUrl}/v1beta/models/${pathStr}`;
    const headers = buildUpstreamHeaders(channel.apiKey, "gemini");

    console.log(`[Proxy] Gemini request for model "${modelName}" -> channel "${channel.channelName}"`);

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
    console.error("[Proxy /v1beta/models] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}

// Also support GET for model info requests
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Verify proxy API key
  const authError = verifyProxyKey(request);
  if (authError) return authError;

  try {
    const { path } = await params;
    const modelName = path.join("/");

    // Find channel by model name
    const channel = await findChannelByModel(modelName);
    if (!channel) {
      return errorResponse(`Model not found: ${modelName}`, 404);
    }

    // Normalize baseUrl
    let baseUrl = normalizeBaseUrl(channel.baseUrl);
    if (baseUrl.endsWith("/v1beta")) {
      baseUrl = baseUrl.slice(0, -7);
    }

    const url = `${baseUrl}/v1beta/models/${modelName}`;
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
    console.error("[Proxy /v1beta/models GET] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Proxy error: ${message}`, 502);
  }
}
