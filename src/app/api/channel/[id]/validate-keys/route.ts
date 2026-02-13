// Validate API keys for a channel - returns models per key

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { fetchModels } from "@/lib/detection";

function maskKey(key: string): string {
  if (key.length > 12) return key.slice(0, 8) + "..." + key.slice(-4);
  return "***";
}

// POST /api/channel/[id]/validate-keys - Validate all keys and return model lists
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const channel = await prisma.channel.findUnique({
      where: { id },
      include: {
        channelKeys: { select: { id: true, apiKey: true } },
      },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "渠道不存在", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Build key list: always include default key + channel keys
    const keysToValidate: { keyId: string | null; apiKey: string }[] = [
      { keyId: null, apiKey: channel.apiKey },
    ];
    for (const k of channel.channelKeys) {
      keysToValidate.push({ keyId: k.id, apiKey: k.apiKey });
    }

    // Validate each key concurrently, collecting models
    const validateResults = await Promise.allSettled(
      keysToValidate.map(async ({ keyId, apiKey }) => {
        try {
          const result = await fetchModels(channel.baseUrl, apiKey, channel.proxy);
          const valid = !result.error;
          const models = result.models || [];

          // Update ChannelKey status if it's a channel key
          if (keyId) {
            await prisma.channelKey.update({
              where: { id: keyId },
              data: { lastValid: valid, lastCheckedAt: new Date() },
            });
          }

          return {
            keyId,
            maskedKey: maskKey(apiKey),
            valid,
            modelCount: models.length,
            models,
            error: result.error || undefined,
          };
        } catch (err) {
          if (keyId) {
            await prisma.channelKey.update({
              where: { id: keyId },
              data: { lastValid: false, lastCheckedAt: new Date() },
            });
          }
          return {
            keyId,
            maskedKey: maskKey(apiKey),
            valid: false,
            modelCount: 0,
            models: [] as string[],
            error: err instanceof Error ? err.message : "验证失败",
          };
        }
      })
    );

    const results = validateResults.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { keyId: null, maskedKey: "***", valid: false, modelCount: 0, models: [], error: "验证异常" }
    );

    // 返回该渠道已有的模型列表，用于同步时预选
    const existingModels = await prisma.model.findMany({
      where: { channelId: id },
      select: { modelName: true },
    });

    return NextResponse.json({
      results,
      existingModels: existingModels.map((m) => m.modelName),
    });
  } catch {
    return NextResponse.json(
      { error: "验证失败", code: "VALIDATE_ERROR" },
      { status: 500 }
    );
  }
}
