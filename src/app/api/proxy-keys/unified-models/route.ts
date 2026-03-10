// GET /api/proxy-keys/unified-models - 获取去重后的裸模型名列表
// 供前端在统一模式下选择可用模型

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const models = await prisma.model.findMany({
      where: {
        lastStatus: true,
        channel: { enabled: true },
      },
      select: { modelName: true },
      distinct: ["modelName"],
      orderBy: { modelName: "asc" },
    });

    return NextResponse.json({ models: models.map((m) => m.modelName) });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch unified models", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
