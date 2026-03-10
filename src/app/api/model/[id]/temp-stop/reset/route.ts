import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { prisma } from "@/lib/prisma";
import {
  clearTemporaryStoppedModel,
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
    const model = await prisma.model.findUnique({
      where: { id },
      select: {
        id: true,
        modelName: true,
      },
    });

    if (!model) {
      return NextResponse.json(
        { error: "模型不存在", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const clearedCount = await clearTemporaryStoppedModel(model.id);

    return NextResponse.json({
      success: true,
      modelId: model.id,
      modelName: model.modelName,
      clearedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "恢复失败";
    return NextResponse.json(
      { error: message, code: "RESET_TEMP_STOP_FAILED" },
      { status: 500 }
    );
  }
}
