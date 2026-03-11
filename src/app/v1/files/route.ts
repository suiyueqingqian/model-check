import { NextRequest, NextResponse } from "next/server";
import {
  buildUpstreamHeaders,
  errorResponse,
  getProxyChannelCandidatesWithPermission,
  normalizeBaseUrl,
  type ProxyChannelCandidate,
  verifyProxyKeyAsync,
} from "@/lib/proxy";
import { isClaudeModelName, isGeminiModelName } from "@/lib/proxy/compat";
import { setProxyFileBinding } from "@/lib/proxy/file-bindings";
import { proxyFetch } from "@/lib/utils/proxy-fetch";

const FILE_PROXY_TIMEOUT = 600000;
const CLAUDE_FILES_BETA = "files-api-2025-04-14";

function appendBetaHeader(existingValue: string | null, betaValue: string): string {
  const values = new Set(
    (existingValue || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  values.add(betaValue);
  return Array.from(values).join(",");
}

async function buildMultipartBody(formData: FormData): Promise<{
  body: Buffer;
  contentType: string | null;
}> {
  const encodedFormData = new Response(formData);
  return {
    body: Buffer.from(await encodedFormData.arrayBuffer()),
    contentType: encodedFormData.headers.get("Content-Type"),
  };
}

async function proxyWithTimeout(
  url: string,
  init: Parameters<typeof proxyFetch>[1],
  proxy?: string | null
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FILE_PROXY_TIMEOUT);

  try {
    return await proxyFetch(
      url,
      {
        ...init,
        signal: controller.signal,
      },
      proxy
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function bindUploadedReference(
  reference: string | null | undefined,
  channel: ProxyChannelCandidate,
  requestedModel: string
): Promise<void> {
  if (!reference || !reference.trim()) {
    return;
  }

  await setProxyFileBinding(reference, {
    channelId: channel.channelId,
    channelKeyId: channel.channelKeyId,
    requestedModel,
    actualModelName: channel.actualModelName,
    createdAt: new Date().toISOString(),
  });
}

async function uploadOpenAiFile(
  channel: ProxyChannelCandidate,
  formData: FormData
): Promise<Response> {
  const purpose = formData.get("purpose");
  if (typeof purpose !== "string" || !purpose.trim()) {
    formData.set("purpose", "user_data");
  }

  const { body, contentType } = await buildMultipartBody(formData);
  const headers = buildUpstreamHeaders(channel.apiKey, "openai", undefined, {
    includeContentType: false,
  });
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return proxyWithTimeout(
    `${normalizeBaseUrl(channel.baseUrl)}/v1/files`,
    {
      method: "POST",
      headers,
      body,
    },
    channel.proxy
  );
}

async function uploadClaudeFile(
  channel: ProxyChannelCandidate,
  formData: FormData,
  anthropicBetaHeader: string | null
): Promise<Response> {
  const { body, contentType } = await buildMultipartBody(formData);
  const headers = buildUpstreamHeaders(
    channel.apiKey,
    "anthropic",
    {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": appendBetaHeader(anthropicBetaHeader, CLAUDE_FILES_BETA),
    },
    {
      includeContentType: false,
    }
  );
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return proxyWithTimeout(
    `${normalizeBaseUrl(channel.baseUrl)}/v1/files`,
    {
      method: "POST",
      headers,
      body,
    },
    channel.proxy
  );
}

async function uploadGeminiFile(
  channel: ProxyChannelCandidate,
  file: File
): Promise<Response> {
  let baseUrl = normalizeBaseUrl(channel.baseUrl);
  if (baseUrl.endsWith("/v1beta")) {
    baseUrl = baseUrl.slice(0, -7);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const startResponse = await proxyWithTimeout(
    `${baseUrl}/upload/v1beta/files`,
    {
      method: "POST",
      headers: {
        ...buildUpstreamHeaders(channel.apiKey, "gemini"),
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({
        file: {
          display_name: file.name,
        },
      }),
    },
    channel.proxy
  );

  if (!startResponse.ok) {
    return startResponse;
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini 上传初始化成功，但没有返回上传地址");
  }

  return proxyWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(bytes.length),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: bytes,
    },
    channel.proxy
  );
}

export async function POST(request: NextRequest) {
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) {
    return authError;
  }

  try {
    const formData = await request.formData();
    const model = formData.get("model");
    const file = formData.get("file");

    if (typeof model !== "string" || !model.trim()) {
      return errorResponse("上传文件时必须带 model 字段，用来锁定上游渠道", 400);
    }

    if (!(file instanceof File)) {
      return errorResponse("缺少 file 文件字段", 400);
    }

    const requestedModel = model.trim();
    const preferredEndpoint = isClaudeModelName(requestedModel)
      ? "CLAUDE"
      : isGeminiModelName(requestedModel)
        ? "GEMINI"
        : "CODEX";
    const { candidates } = await getProxyChannelCandidatesWithPermission(
      requestedModel,
      keyResult!,
      preferredEndpoint
    );

    if (candidates.length === 0) {
      return errorResponse(`没有找到可上传文件的可用渠道: ${requestedModel}`, 404);
    }

    const channel = candidates[0];
    const upstreamFormData = new FormData();
    for (const [key, value] of formData.entries()) {
      if (key === "model") {
        continue;
      }

      if (value instanceof File) {
        upstreamFormData.append(key, value, value.name);
      } else if (typeof value === "string") {
        upstreamFormData.append(key, value);
      }
    }

    const response = isGeminiModelName(channel.actualModelName)
      ? await uploadGeminiFile(channel, file)
      : isClaudeModelName(channel.actualModelName)
        ? await uploadClaudeFile(channel, upstreamFormData, request.headers.get("anthropic-beta"))
        : await uploadOpenAiFile(channel, upstreamFormData);

    const contentType = response.headers.get("Content-Type") || "application/json";
    const text = await response.text();

    if (!response.ok) {
      return new NextResponse(text, {
        status: response.status,
        headers: {
          "Content-Type": contentType,
        },
      });
    }

    try {
      const payload = JSON.parse(text) as {
        id?: unknown;
        file?: {
          name?: unknown;
          uri?: unknown;
        };
      };

      await bindUploadedReference(
        typeof payload.id === "string" ? payload.id : null,
        channel,
        requestedModel
      );

      await bindUploadedReference(
        typeof payload.file?.name === "string" ? payload.file.name : null,
        channel,
        requestedModel
      );

      await bindUploadedReference(
        typeof payload.file?.uri === "string" ? payload.file.uri : null,
        channel,
        requestedModel
      );
    } catch {
    }

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return errorResponse(`文件上传超时，超过 ${FILE_PROXY_TIMEOUT}ms`, 504);
    }

    return errorResponse(
      `文件上传失败: ${error instanceof Error ? error.message : "Unknown error"}`,
      500
    );
  }
}
