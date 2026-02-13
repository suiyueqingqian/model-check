// Toggle all model keywords enabled/disabled

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

// PUT /api/model-keywords/toggle-all - Toggle all keywords
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { enabled } = body;

    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled 必须是布尔值", code: "INVALID_DATA" },
        { status: 400 }
      );
    }

    await prisma.modelKeyword.updateMany({
      data: { enabled },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "批量更新失败", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}
