// Proxy Keys API - List and create proxy API keys

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import prisma from "@/lib/prisma";
import {
  BUILTIN_PROXY_KEY_DB_ID,
  generateApiKey,
  getBuiltInProxyKeyInfo,
  maskKey,
} from "@/lib/utils/proxy-key";

const TEMPORARY_STOP_UNITS = ["second", "minute", "hour", "day"] as const;
const UNIFIED_ROUTE_STRATEGIES = ["round_robin", "random"] as const;

// GET /api/proxy-keys - List all proxy keys
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const keys = await prisma.proxyKey.findMany({
      where: {
        id: {
          not: BUILTIN_PROXY_KEY_DB_ID,
        },
      },
      select: {
        id: true,
        name: true,
        key: true,
        enabled: true,
        allowAllModels: true,
        allowedChannelIds: true,
        allowedModelIds: true,
        unifiedMode: true,
        allowedUnifiedModels: true,
        temporaryStopValue: true,
        temporaryStopUnit: true,
        unifiedRouteStrategy: true,
        lastUsedAt: true,
        usageCount: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Mask keys in response (show only first 8 and last 4 chars)
    const maskedKeys = keys.map((key) => ({
      ...key,
      key: maskKey(key.key),
      fullKey: key.key,
      source: "database" as const,
    }));

    // Add the built-in key (env or auto-generated) at the top
    const builtInKey = await getBuiltInProxyKeyInfo();
    const builtInEntry = {
      id: builtInKey.id,
      name: builtInKey.name,
      key: maskKey(builtInKey.key),
      fullKey: builtInKey.key,
      enabled: builtInKey.enabled,
      allowAllModels: builtInKey.allowAllModels,
      allowedChannelIds: builtInKey.allowedChannelIds,
      allowedModelIds: builtInKey.allowedModelIds,
      unifiedMode: builtInKey.unifiedMode,
      allowedUnifiedModels: builtInKey.allowedUnifiedModels,
      temporaryStopValue: builtInKey.temporaryStopValue,
      temporaryStopUnit: builtInKey.temporaryStopUnit,
      unifiedRouteStrategy: builtInKey.unifiedRouteStrategy,
      lastUsedAt: builtInKey.lastUsedAt,
      usageCount: builtInKey.usageCount,
      createdAt: builtInKey.createdAt,
      updatedAt: builtInKey.updatedAt,
      source: builtInKey.source,
    };

    return NextResponse.json({ keys: [builtInEntry, ...maskedKeys] });
  } catch {
    return NextResponse.json(
      { error: "Failed to list proxy keys", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/proxy-keys - Create a new proxy key
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const {
      name,
      key: customKey,
      enabled = true,
      allowAllModels = true,
      allowedChannelIds,
      allowedModelIds,
      unifiedMode = true,
      allowedUnifiedModels,
      temporaryStopValue = 10,
      temporaryStopUnit = "minute",
      unifiedRouteStrategy = "round_robin",
    } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required", code: "MISSING_NAME" },
        { status: 400 }
      );
    }

    // 校验数组类型字段
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((i) => typeof i === "string");

    if (allowedChannelIds != null && !isStringArray(allowedChannelIds)) {
      return NextResponse.json(
        { error: "allowedChannelIds must be a string array", code: "INVALID_TYPE" },
        { status: 400 }
      );
    }
    if (allowedModelIds != null && !isStringArray(allowedModelIds)) {
      return NextResponse.json(
        { error: "allowedModelIds must be a string array", code: "INVALID_TYPE" },
        { status: 400 }
      );
    }
    if (allowedUnifiedModels != null && !isStringArray(allowedUnifiedModels)) {
      return NextResponse.json(
        { error: "allowedUnifiedModels must be a string array", code: "INVALID_TYPE" },
        { status: 400 }
      );
    }
    if (
      typeof temporaryStopValue !== "number" ||
      !Number.isFinite(temporaryStopValue) ||
      temporaryStopValue < 0 ||
      !Number.isInteger(temporaryStopValue)
    ) {
      return NextResponse.json(
        { error: "temporaryStopValue must be a non-negative integer", code: "INVALID_TYPE" },
        { status: 400 }
      );
    }
    if (
      typeof temporaryStopUnit !== "string" ||
      !(TEMPORARY_STOP_UNITS as readonly string[]).includes(temporaryStopUnit)
    ) {
      return NextResponse.json(
        { error: "temporaryStopUnit is invalid", code: "INVALID_ENUM" },
        { status: 400 }
      );
    }
    if (
      typeof unifiedRouteStrategy !== "string" ||
      !(UNIFIED_ROUTE_STRATEGIES as readonly string[]).includes(unifiedRouteStrategy)
    ) {
      return NextResponse.json(
        { error: "unifiedRouteStrategy is invalid", code: "INVALID_ENUM" },
        { status: 400 }
      );
    }

    // Generate or use custom key
    let key = customKey;
    if (!key) {
      key = generateApiKey();
    } else if (!key.startsWith("sk-")) {
      return NextResponse.json(
        { error: "Custom key must start with 'sk-'", code: "INVALID_KEY_FORMAT" },
        { status: 400 }
      );
    }

    // Check for duplicate key
    const builtInKey = await getBuiltInProxyKeyInfo();
    if (key === builtInKey.key) {
      return NextResponse.json(
        { error: "Key already exists", code: "DUPLICATE_KEY" },
        { status: 409 }
      );
    }

    const existing = await prisma.proxyKey.findUnique({
      where: { key },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Key already exists", code: "DUPLICATE_KEY" },
        { status: 409 }
      );
    }

    // Create the key
    const proxyKey = await prisma.proxyKey.create({
      data: {
        name: name.trim(),
        key,
        enabled,
        allowAllModels,
        allowedChannelIds: allowedChannelIds ?? null,
        allowedModelIds: allowedModelIds ?? null,
        unifiedMode,
        allowedUnifiedModels: allowedUnifiedModels ?? null,
        temporaryStopValue,
        temporaryStopUnit,
        unifiedRouteStrategy,
      },
    });

    return NextResponse.json({
      success: true,
      key: {
        id: proxyKey.id,
        name: proxyKey.name,
        key: proxyKey.key, // Return full key on creation
        enabled: proxyKey.enabled,
        allowAllModels: proxyKey.allowAllModels,
        allowedChannelIds: proxyKey.allowedChannelIds,
        allowedModelIds: proxyKey.allowedModelIds,
        unifiedMode: proxyKey.unifiedMode,
        allowedUnifiedModels: proxyKey.allowedUnifiedModels,
        temporaryStopValue: proxyKey.temporaryStopValue,
        temporaryStopUnit: proxyKey.temporaryStopUnit,
        unifiedRouteStrategy: proxyKey.unifiedRouteStrategy,
        createdAt: proxyKey.createdAt,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to create proxy key", code: "CREATE_ERROR" },
      { status: 500 }
    );
  }
}
