// POST /v1/images/generations - Proxy OpenAI Images API
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
  recordProxyModelResult,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKeyAsync,
} from "@/lib/proxy";

type ProxyAttemptFailure = {
  modelId: string;
  latency?: number;
  statusCode?: number;
  errorMsg: string;
};

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

    const { candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "IMAGE");
    if (candidates.length === 0) {
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    const pendingFailures: ProxyAttemptFailure[] = [];

    for (const channel of candidates) {
      const startedAt = Date.now();

      try {
        const upstreamBody = { ...body, model: channel.actualModelName };
        const baseUrl = normalizeBaseUrl(channel.baseUrl);
        const url = `${baseUrl}/v1/images/generations`;
        const headers = buildUpstreamHeaders(channel.apiKey, "openai");
        const response = await proxyRequest(url, "POST", headers, upstreamBody, channel.proxy);
        const latency = Date.now() - startedAt;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          lastErrorMessage = `Upstream error: ${response.status} - ${errorText.slice(0, 500)}`;
          lastStatus = response.status;

          if (channel.modelId) {
            pendingFailures.push({
              modelId: channel.modelId,
              latency,
              statusCode: response.status,
              errorMsg: lastErrorMessage,
            });
          }

          continue;
        }

        const data = await response.json();

        if (channel.modelId) {
          await recordProxyModelResult(channel.modelId, "IMAGE", true, {
            channelId: channel.channelId,
            modelName: channel.actualModelName,
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          }).catch(() => {});
        }

        return NextResponse.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lastErrorMessage = `Proxy error: ${message}`;
        lastStatus = 502;

        if (channel.modelId) {
          pendingFailures.push({
            modelId: channel.modelId,
            latency: Date.now() - startedAt,
            statusCode: 502,
            errorMsg: lastErrorMessage,
          });
        }
      }
    }

    if (pendingFailures.length > 0) {
      await Promise.all(
        pendingFailures.map((failure) =>
          recordProxyModelResult(failure.modelId, "IMAGE", false, {
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
