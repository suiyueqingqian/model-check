// Public channel upload API - allows unauthenticated users to submit channels for review

import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";
import prisma from "@/lib/prisma";
import { fetchModels } from "@/lib/detection";
import { isAuthenticated } from "@/lib/middleware/auth";

interface PublicUploadBody {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

function normalizeBaseUrlForCompare(baseUrl: string): string {
  let normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

function isPrivateOrLocalIp(ip: string): boolean {
  const normalizedIp = ip.toLowerCase();

  if (normalizedIp === "::1" || normalizedIp === "0:0:0:0:0:0:0:1") return true;
  if (normalizedIp.startsWith("fe80:")) return true;
  if (normalizedIp.startsWith("fc") || normalizedIp.startsWith("fd")) return true;

  if (normalizedIp.startsWith("::ffff:")) {
    return isPrivateOrLocalIp(normalizedIp.slice(7));
  }

  if (net.isIP(normalizedIp) !== 4) return false;

  const parts = normalizedIp.split(".").map((n) => Number(n));
  const [a, b] = parts;

  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;

  return false;
}

async function isUnsafeBaseUrl(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  if (net.isIP(hostname) > 0 && isPrivateOrLocalIp(hostname)) {
    return true;
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.some((record) => isPrivateOrLocalIp(record.address))) {
      return true;
    }
  } catch {
    // lookup failure will be handled by real request phase
  }

  return false;
}

// POST /api/channel/public-upload - Submit channel for review (unauthenticated)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as PublicUploadBody;
    const name = body.name?.trim() || "";
    const baseUrl = body.baseUrl?.trim() || "";
    const apiKey = body.apiKey?.trim() || "";

    if (!name || !baseUrl || !apiKey) {
      return NextResponse.json(
        { error: "渠道名称、Base URL 和 Key 为必填项", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      return NextResponse.json(
        { error: "Base URL 格式不正确", code: "INVALID_BASE_URL" },
        { status: 400 }
      );
    }

    if (await isUnsafeBaseUrl(parsedUrl)) {
      return NextResponse.json(
        { error: "Base URL 不允许本地或内网地址", code: "UNSAFE_BASE_URL" },
        { status: 400 }
      );
    }

    if (!isAuthenticated(request)) {
      const envProxyApiKey = process.env.PROXY_API_KEY?.trim();
      const existsProjectProxyKey = await prisma.proxyKey.findFirst({
        where: { key: apiKey },
        select: { id: true },
      });
      if ((envProxyApiKey && apiKey === envProxyApiKey) || existsProjectProxyKey) {
        return NextResponse.json(
          { error: "请使用自定义渠道 Key，不能使用项目内置 Key", code: "PROJECT_KEY_NOT_ALLOWED" },
          { status: 400 }
        );
      }
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const compareBaseUrl = normalizeBaseUrlForCompare(baseUrl);

    // Prevent duplicate submissions using normalized baseUrl + apiKey
    const existingChannels = await prisma.channel.findMany({
      select: { baseUrl: true, apiKey: true },
    });
    const isDuplicate = existingChannels.some(
      (channel) =>
        normalizeBaseUrlForCompare(channel.baseUrl) === compareBaseUrl &&
        channel.apiKey === apiKey
    );

    if (isDuplicate) {
      return NextResponse.json(
        { error: "该渠道已存在，请勿重复上传", code: "DUPLICATE_CHANNEL" },
        { status: 409 }
      );
    }

    // Check for duplicate channel name
    const existingByName = await prisma.channel.findFirst({
      where: { name },
      select: { id: true },
    });
    if (existingByName) {
      return NextResponse.json(
        { error: "该渠道名称已存在，请使用其他名称", code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }

    // Validate channel by fetching OpenAI-compatible /v1/models
    const modelResult = await fetchModels(normalizedBaseUrl, apiKey);
    if (modelResult.error || modelResult.models.length === 0) {
      return NextResponse.json(
        { error: "请检查你的渠道是否可用", code: "MODEL_FETCH_FAILED" },
        { status: 400 }
      );
    }

    const uniqueModels = Array.from(
      new Set(modelResult.models.filter((model) => typeof model === "string" && model.length > 0))
    );

    const channel = await prisma.$transaction(async (tx) => {
      const minSort = await tx.channel.aggregate({
        _min: { sortOrder: true },
      });
      const nextSortOrder = (minSort._min.sortOrder ?? 0) - 1;

      const createdChannel = await tx.channel.create({
        data: {
          name,
          baseUrl: normalizedBaseUrl,
          apiKey,
          enabled: true,
          sortOrder: nextSortOrder,
        },
      });

      await tx.model.createMany({
        data: uniqueModels.map((modelName) => ({
          channelId: createdChannel.id,
          modelName,
        })),
        skipDuplicates: true,
      });

      return createdChannel;
    });

    return NextResponse.json({
      success: true,
      message: "上传成功，等待审核",
      channelId: channel.id,
      modelCount: uniqueModels.length,
    });
  } catch {
    return NextResponse.json(
      { error: "上传失败，请稍后重试", code: "PUBLIC_UPLOAD_ERROR" },
      { status: 500 }
    );
  }
}
