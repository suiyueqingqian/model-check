// Channel Keys API - Manage additional API keys for a channel

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

// GET /api/channel/[id]/keys - List all extra keys (masked)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const keys = await prisma.channelKey.findMany({
      where: { channelId: id },
      orderBy: { createdAt: "asc" },
    });

    const maskedKeys = keys.map((k) => ({
      id: k.id,
      name: k.name,
      maskedKey: k.apiKey.length > 12
        ? k.apiKey.slice(0, 8) + "..." + k.apiKey.slice(-4)
        : "***",
      fullKey: k.apiKey,
      lastValid: k.lastValid ?? null,
      lastCheckedAt: k.lastCheckedAt,
      createdAt: k.createdAt,
    }));

    return NextResponse.json({ keys: maskedKeys });
  } catch {
    return NextResponse.json(
      { error: "获取 Key 列表失败", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/channel/[id]/keys - Add extra key
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const { apiKey, name } = body;

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json(
        { error: "API Key 不能为空", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    // Verify channel exists
    const channel = await prisma.channel.findUnique({ where: { id } });
    if (!channel) {
      return NextResponse.json(
        { error: "渠道不存在", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const key = await prisma.channelKey.create({
      data: {
        channelId: id,
        apiKey: apiKey.trim(),
        name: name?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      key: {
        id: key.id,
        name: key.name,
        apiKey: key.apiKey.length > 12
          ? key.apiKey.slice(0, 8) + "..." + key.apiKey.slice(-4)
          : "***",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "添加 Key 失败", code: "CREATE_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/channel/[id]/keys - Update key
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const { keyId, apiKey, name } = body;

    if (!keyId) {
      return NextResponse.json(
        { error: "keyId 不能为空", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (apiKey !== undefined && apiKey.trim()) updateData.apiKey = apiKey.trim();
    if (name !== undefined) updateData.name = name?.trim() || null;

    const existing = await prisma.channelKey.findFirst({
      where: { id: keyId, channelId: id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Key not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const updated = await prisma.channelKey.update({
      where: { id: existing.id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      key: {
        id: updated.id,
        name: updated.name,
        apiKey: updated.apiKey.length > 12
          ? updated.apiKey.slice(0, 8) + "..." + updated.apiKey.slice(-4)
          : "***",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "更新 Key 失败", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}

// DELETE /api/channel/[id]/keys?keyId=xxx - Delete key
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get("keyId");

    if (!keyId) {
      return NextResponse.json(
        { error: "keyId 不能为空", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    const existing = await prisma.channelKey.findFirst({
      where: { id: keyId, channelId: id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Key not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    await prisma.channelKey.delete({ where: { id: existing.id } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "删除 Key 失败", code: "DELETE_ERROR" },
      { status: 500 }
    );
  }
}
