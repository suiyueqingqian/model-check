// Proxy Key API - Update and delete individual proxy keys

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import {
  BUILTIN_PROXY_KEY_DB_ID,
  BUILTIN_PROXY_KEY_ROUTE_ID,
  getBuiltInProxyKeyInfo,
  maskKey,
} from "@/lib/utils/proxy-key";

// GET /api/proxy-keys/[id] - Get a specific proxy key (with full key)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    // Handle built-in key
    if (id === BUILTIN_PROXY_KEY_ROUTE_ID) {
      const builtInKey = await getBuiltInProxyKeyInfo();
      return NextResponse.json({
        key: {
          id: builtInKey.id,
          name: builtInKey.name,
          key: builtInKey.key,
          enabled: builtInKey.enabled,
          allowAllModels: builtInKey.allowAllModels,
          allowedChannelIds: builtInKey.allowedChannelIds,
          allowedModelIds: builtInKey.allowedModelIds,
          unifiedMode: builtInKey.unifiedMode,
          allowedUnifiedModels: builtInKey.allowedUnifiedModels,
          source: builtInKey.source,
        },
      });
    }

    const key = await prisma.proxyKey.findUnique({
      where: { id },
    });

    if (!key) {
      return NextResponse.json(
        { error: "Proxy key not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    return NextResponse.json({ key });
  } catch {
    return NextResponse.json(
      { error: "Failed to get proxy key", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/proxy-keys/[id] - Update a proxy key
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      key,
      enabled,
      allowAllModels,
      allowedChannelIds,
      allowedModelIds,
      unifiedMode,
      allowedUnifiedModels,
    } = body;

    if (id === BUILTIN_PROXY_KEY_ROUTE_ID) {
      const normalizedKey = typeof key === "string" ? key.trim() : "";
      const normalizedAllowAllModels = allowAllModels !== undefined ? Boolean(allowAllModels) : true;
      const normalizedUnifiedMode = unifiedMode !== undefined ? Boolean(unifiedMode) : true;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name is required", code: "MISSING_NAME" },
          { status: 400 }
        );
      }

      if (!normalizedKey) {
        return NextResponse.json(
          { error: "Key is required", code: "MISSING_KEY" },
          { status: 400 }
        );
      }

      if (!normalizedKey.startsWith("sk-")) {
        return NextResponse.json(
          { error: "Custom key must start with 'sk-'", code: "INVALID_KEY_FORMAT" },
          { status: 400 }
        );
      }

      const existingByKey = await prisma.proxyKey.findUnique({
        where: { key: normalizedKey },
      });
      if (existingByKey && existingByKey.id !== BUILTIN_PROXY_KEY_DB_ID) {
        return NextResponse.json(
          { error: "Key already exists", code: "DUPLICATE_KEY" },
          { status: 409 }
        );
      }

      const builtInKey = await prisma.proxyKey.upsert({
        where: { id: BUILTIN_PROXY_KEY_DB_ID },
        update: {
          name: name.trim(),
          key: normalizedKey,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
          allowAllModels: normalizedAllowAllModels,
          allowedChannelIds: normalizedAllowAllModels ? Prisma.JsonNull : (allowedChannelIds ?? Prisma.JsonNull),
          allowedModelIds: normalizedAllowAllModels ? Prisma.JsonNull : (allowedModelIds ?? Prisma.JsonNull),
          unifiedMode: normalizedUnifiedMode,
          allowedUnifiedModels:
            normalizedUnifiedMode && !normalizedAllowAllModels
              ? (allowedUnifiedModels ?? Prisma.JsonNull)
              : Prisma.JsonNull,
        },
        create: {
          id: BUILTIN_PROXY_KEY_DB_ID,
          name: name.trim(),
          key: normalizedKey,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
          allowAllModels: normalizedAllowAllModels,
          allowedChannelIds: normalizedAllowAllModels ? Prisma.JsonNull : (allowedChannelIds ?? Prisma.JsonNull),
          allowedModelIds: normalizedAllowAllModels ? Prisma.JsonNull : (allowedModelIds ?? Prisma.JsonNull),
          unifiedMode: normalizedUnifiedMode,
          allowedUnifiedModels:
            normalizedUnifiedMode && !normalizedAllowAllModels
              ? (allowedUnifiedModels ?? Prisma.JsonNull)
              : Prisma.JsonNull,
        },
      });

      return NextResponse.json({
        success: true,
        key: {
          id: BUILTIN_PROXY_KEY_ROUTE_ID,
          name: builtInKey.name,
          key: builtInKey.key,
          enabled: builtInKey.enabled,
          allowAllModels: builtInKey.allowAllModels,
          allowedChannelIds: builtInKey.allowedChannelIds,
          allowedModelIds: builtInKey.allowedModelIds,
          unifiedMode: builtInKey.unifiedMode,
          allowedUnifiedModels: builtInKey.allowedUnifiedModels,
          source: "builtin",
          updatedAt: builtInKey.updatedAt,
        },
      });
    }

    // Check if key exists
    const existing = await prisma.proxyKey.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Proxy key not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Update the key
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (enabled !== undefined) updateData.enabled = enabled;
    if (allowAllModels !== undefined) updateData.allowAllModels = allowAllModels;
    if (allowedChannelIds !== undefined) updateData.allowedChannelIds = allowedChannelIds === null ? Prisma.JsonNull : allowedChannelIds;
    if (allowedModelIds !== undefined) updateData.allowedModelIds = allowedModelIds === null ? Prisma.JsonNull : allowedModelIds;
    if (unifiedMode !== undefined) updateData.unifiedMode = unifiedMode;
    if (allowedUnifiedModels !== undefined) updateData.allowedUnifiedModels = allowedUnifiedModels === null ? Prisma.JsonNull : allowedUnifiedModels;

    // Handle key regeneration
    if (key !== undefined && typeof key === "string" && key.trim()) {
      const normalizedKey = key.trim();
      if (!normalizedKey.startsWith("sk-")) {
        return NextResponse.json(
          { error: "Key must start with 'sk-'", code: "INVALID_KEY_FORMAT" },
          { status: 400 }
        );
      }
      const existingByKey = await prisma.proxyKey.findUnique({
        where: { key: normalizedKey },
      });
      if (existingByKey && existingByKey.id !== id) {
        return NextResponse.json(
          { error: "Key already exists", code: "DUPLICATE_KEY" },
          { status: 409 }
        );
      }
      updateData.key = normalizedKey;
    }

    const updatedKey = await prisma.proxyKey.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      key: {
        id: updatedKey.id,
        name: updatedKey.name,
        key: maskKey(updatedKey.key),
        enabled: updatedKey.enabled,
        allowAllModels: updatedKey.allowAllModels,
        allowedChannelIds: updatedKey.allowedChannelIds,
        allowedModelIds: updatedKey.allowedModelIds,
        unifiedMode: updatedKey.unifiedMode,
        allowedUnifiedModels: updatedKey.allowedUnifiedModels,
        updatedAt: updatedKey.updatedAt,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to update proxy key", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}

// DELETE /api/proxy-keys/[id] - Delete a proxy key
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    if (id === BUILTIN_PROXY_KEY_ROUTE_ID) {
      return NextResponse.json(
        { error: "Built-in proxy key cannot be deleted", code: "FORBIDDEN" },
        { status: 400 }
      );
    }

    // Check if key exists
    const existing = await prisma.proxyKey.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Proxy key not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Delete the key
    await prisma.proxyKey.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: "Proxy key deleted",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete proxy key", code: "DELETE_ERROR" },
      { status: 500 }
    );
  }
}
