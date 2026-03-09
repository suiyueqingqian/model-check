// POST /v1/images/generations - Proxy OpenAI Images API
// Automatically routes to the correct channel based on model name

import { NextRequest, NextResponse } from "next/server";
import {
  getProxyChannelCandidatesWithPermission,
  buildUpstreamHeaders,
  proxyRequest,
  recordProxyModelResult,
  recordProxyRequestLog,
  errorResponse,
  normalizeBaseUrl,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import { createAsyncErrorHandler } from "@/lib/utils/error";

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
    const requestPath = request.nextUrl?.pathname ?? new URL(request.url).pathname;
    const requestMethod = request.method;
    const handleWriteRequestLogError = createAsyncErrorHandler("[ImageProxy] 写请求日志失败", "warn");
    const handleRecordModelResultError = createAsyncErrorHandler("[ImageProxy] 记录模型结果失败", "warn");
    const writeRequestLog = (options: {
      requestedModel?: string | null;
      actualModelName?: string | null;
      channelId?: string | null;
      channelName?: string | null;
      modelId?: string | null;
      success: boolean;
      statusCode?: number;
      latency?: number;
      errorMsg?: string | null;
    }) => recordProxyRequestLog({
      keyResult,
      requestPath,
      requestMethod,
      endpointType: "IMAGE",
      ...options,
    }).catch(handleWriteRequestLogError);
    const recordModelResult = (
      ...args: Parameters<typeof recordProxyModelResult>
    ) => recordProxyModelResult(...args).catch(handleRecordModelResultError);

    const body = await request.json();
    const modelName = body.model;

    if (!modelName) {
      await writeRequestLog({
        requestedModel: null,
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
          requestedModel: typeof modelName === "string" ? modelName : null,
          success: false,
          statusCode: 400,
          errorMsg: "Model must use channel prefix format: channelName/modelName",
        });
        return errorResponse("Model must use channel prefix format: channelName/modelName", 400);
      }
    } else {
      if (typeof modelName !== "string" || modelName.trim().length === 0) {
        await writeRequestLog({
          requestedModel: typeof modelName === "string" ? modelName : null,
          success: false,
          statusCode: 400,
          errorMsg: "Missing or invalid 'model' field",
        });
        return errorResponse("Missing or invalid 'model' field", 400);
      }
    }

    const { candidates } = await getProxyChannelCandidatesWithPermission(modelName, keyResult!, "IMAGE");
    if (candidates.length === 0) {
      await writeRequestLog({
        requestedModel: modelName,
        success: false,
        statusCode: 404,
        errorMsg: `Model not found or access denied: ${modelName}`,
      });
      return errorResponse(`Model not found or access denied: ${modelName}`, 404);
    }

    let lastErrorMessage = `Model not found or access denied: ${modelName}`;
    let lastStatus = 404;
    let finalFailureLog: {
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
          finalFailureLog = {
            actualModelName: channel.actualModelName,
            channelId: channel.channelId,
            channelName: channel.channelName,
            modelId: channel.modelId,
            statusCode: response.status,
            latency,
            errorMsg: lastErrorMessage,
          };

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
          await recordModelResult(channel.modelId, "IMAGE", true, {
            channelId: channel.channelId,
            modelName: channel.actualModelName,
            latency,
            statusCode: response.status,
            responseContent: "代理请求成功",
          });
        }

        await writeRequestLog({
          requestedModel: modelName,
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          success: true,
          statusCode: response.status,
          latency,
        });

        return NextResponse.json(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lastErrorMessage = `Proxy error: ${message}`;
        lastStatus = 502;
        finalFailureLog = {
          actualModelName: channel.actualModelName,
          channelId: channel.channelId,
          channelName: channel.channelName,
          modelId: channel.modelId,
          statusCode: 502,
          latency: Date.now() - startedAt,
          errorMsg: lastErrorMessage,
        };

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
          recordModelResult(failure.modelId, "IMAGE", false, {
            latency: failure.latency,
            statusCode: failure.statusCode,
            errorMsg: failure.errorMsg,
          })
        )
      );
    }

    await writeRequestLog({
      requestedModel: modelName,
      actualModelName: finalFailureLog?.actualModelName ?? null,
      channelId: finalFailureLog?.channelId ?? null,
      channelName: finalFailureLog?.channelName ?? null,
      modelId: finalFailureLog?.modelId ?? null,
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
