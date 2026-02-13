// Model Keywords API - CRUD operations for model filtering keywords

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

// GET /api/model-keywords - List all keywords
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const keywords = await prisma.modelKeyword.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ keywords });
  } catch {
    return NextResponse.json(
      { error: "获取关键词失败", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/model-keywords - Create keyword
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { keyword } = body;

    if (!keyword || typeof keyword !== "string" || !keyword.trim()) {
      return NextResponse.json(
        { error: "关键词不能为空", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const created = await prisma.modelKeyword.create({
      data: { keyword: keyword.trim() },
    });

    return NextResponse.json({ success: true, keyword: created });
  } catch {
    return NextResponse.json(
      { error: "创建关键词失败", code: "CREATE_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/model-keywords - Update keyword
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { id, keyword, enabled } = body;

    if (!id) {
      return NextResponse.json(
        { error: "ID 不能为空", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (keyword !== undefined) updateData.keyword = String(keyword).trim();
    if (enabled !== undefined) updateData.enabled = Boolean(enabled);

    const updated = await prisma.modelKeyword.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ success: true, keyword: updated });
  } catch {
    return NextResponse.json(
      { error: "更新关键词失败", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}

// DELETE /api/model-keywords?id=xxx - Delete keyword
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "ID 不能为空", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    await prisma.modelKeyword.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "删除关键词失败", code: "DELETE_ERROR" },
      { status: 500 }
    );
  }
}
