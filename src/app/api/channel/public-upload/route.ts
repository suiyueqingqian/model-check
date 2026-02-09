// Public channel upload API - allows unauthenticated users to submit channels for review

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { fetchModels } from "@/lib/detection";

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

    try {
      new URL(baseUrl);
    } catch {
      return NextResponse.json(
        { error: "Base URL 格式不正确", code: "INVALID_BASE_URL" },
        { status: 400 }
      );
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
