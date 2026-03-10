import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { prisma } from "@/lib/prisma";
import {
  clearTemporaryStoppedModelsByChannel,
  shouldAllowAdminTemporaryStopBypass,
} from "@/lib/proxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  if (!shouldAllowAdminTemporaryStopBypass()) {
    return NextResponse.json(
      { error: "管理员临时停用恢复开关未开启", code: "ADMIN_BYPASS_DISABLED" },
      { status: 403 }
    );
  }

  const { id } = await params;

  try {
    const channel = await prisma.channel.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
      },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "渠道不存在", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({} as { credentialKey?: string }));
    const credentialKey = typeof body.credentialKey === "string" && body.credentialKey.trim()
      ? body.credentialKey.trim()
      : undefined;

    const result = await clearTemporaryStoppedModelsByChannel(channel.id, credentialKey);

    return NextResponse.json({
      success: true,
      channelId: channel.id,
      channelName: channel.name,
      credentialKey: credentialKey || null,
      clearedCount: result.clearedCount,
      clearedModels: result.clearedModels,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "恢复失败";
    return NextResponse.json(
      { error: message, code: "RESET_TEMP_STOP_FAILED" },
      { status: 500 }
    );
  }
}
