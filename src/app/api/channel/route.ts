// Channel API - CRUD operations for channels

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

// GET /api/channel - List all channels (authenticated)
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const channels = await prisma.channel.findMany({
      include: {
        _count: {
          select: { models: true, channelKeys: true },
        },
        models: {
          select: { lastStatus: true },
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "desc" },
      ],
    });

    // Mask API keys for security
    const maskedChannels = channels.map((ch) => ({
      ...ch,
      apiKey: ch.apiKey.slice(0, 8) + "..." + ch.apiKey.slice(-4),
    }));

    return NextResponse.json({ channels: maskedChannels });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch channels", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/channel - Create new channel
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { name, baseUrl, apiKey, proxy, models, keyMode = "single", routeStrategy = "round_robin", keys } = body;

    // Validate required fields
    if (!name || !baseUrl || !apiKey) {
      return NextResponse.json(
        { error: "Name, baseUrl, and apiKey are required", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

    // Check if a channel with the same baseUrl already exists → merge keys
    const existingByUrl = await prisma.channel.findFirst({
      where: { baseUrl: normalizedBaseUrl },
      include: { channelKeys: { select: { apiKey: true } } },
    });

    if (existingByUrl) {
      // Collect all keys the user is adding
      const incomingKeys: string[] = [apiKey];
      if (keys && typeof keys === "string") {
        const parsed = keys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
        incomingKeys.push(...parsed);
      }

      // Deduplicate against existing keys
      const existingKeySet = new Set<string>();
      existingKeySet.add(existingByUrl.apiKey);
      for (const ck of existingByUrl.channelKeys) {
        existingKeySet.add(ck.apiKey);
      }
      const newKeys = [...new Set(incomingKeys)].filter((k) => !existingKeySet.has(k));

      if (newKeys.length === 0) {
        return NextResponse.json(
          { error: `相同地址的渠道「${existingByUrl.name}」已存在，且 Key 均已存在`, code: "DUPLICATE_URL" },
          { status: 409 }
        );
      }

      // Add new keys
      await prisma.channelKey.createMany({
        data: newKeys.map((k) => ({
          channelId: existingByUrl.id,
          apiKey: k,
        })),
      });

      // Switch to multi mode if not already
      if (existingByUrl.keyMode !== "multi") {
        await prisma.channel.update({
          where: { id: existingByUrl.id },
          data: { keyMode: "multi" },
        });
      }

      return NextResponse.json({
        success: true,
        merged: true,
        mergedCount: newKeys.length,
        channelName: existingByUrl.name,
        channel: {
          ...existingByUrl,
          apiKey: existingByUrl.apiKey.slice(0, 8) + "...",
        },
      });
    }

    // Check for duplicate channel name
    const existingByName = await prisma.channel.findFirst({
      where: { name },
      select: { id: true },
    });
    if (existingByName) {
      return NextResponse.json(
        { error: "渠道名称已存在", code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }

    // Create channel at first position (new channel appears as list item #1)
    const channel = await prisma.$transaction(async (tx) => {
      const minSort = await tx.channel.aggregate({
        _min: { sortOrder: true },
      });

      const nextSortOrder = (minSort._min.sortOrder ?? 0) - 1;

      return tx.channel.create({
        data: {
          name,
          baseUrl: normalizedBaseUrl,
          apiKey,
          proxy: proxy || null,
          enabled: true,
          sortOrder: nextSortOrder,
          keyMode,
          routeStrategy,
        },
      });
    });

    // Create channel keys for multi-key mode (skip first key, already saved as main apiKey)
    if (keyMode === "multi" && keys && typeof keys === "string") {
      const keyList = keys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
      const extraKeys = keyList.slice(1);
      if (extraKeys.length > 0) {
        await prisma.channelKey.createMany({
          data: extraKeys.map((k: string) => ({
            channelId: channel.id,
            apiKey: k,
          })),
        });
      }
    }

    // If models are provided, create them with empty detectedEndpoints (will be populated after testing)
    if (models && Array.isArray(models) && models.length > 0) {
      const uniqueModels = Array.from(
        new Set(
          models
            .map((modelName: string) => modelName.trim())
            .filter(Boolean)
        )
      );

      await prisma.model.createMany({
        data: uniqueModels.map((modelName: string) => ({
          channelId: channel.id,
          modelName,
        })),
        skipDuplicates: true,
      });
    }

    return NextResponse.json({
      success: true,
      channel: {
        ...channel,
        apiKey: channel.apiKey.slice(0, 8) + "...",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create channel", code: "CREATE_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/channel - Update channel
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { id, name, baseUrl, apiKey, proxy, enabled, orders, keyMode, routeStrategy, keys } = body;

    // Batch update channel sort order
    if (Array.isArray(orders)) {
      await prisma.$transaction(
        orders
          .filter((item) => item && typeof item.id === "string" && typeof item.sortOrder === "number")
          .map((item) =>
            prisma.channel.update({
              where: { id: item.id },
              data: { sortOrder: Math.floor(item.sortOrder) },
            })
          )
      );

      return NextResponse.json({ success: true });
    }

    if (!id) {
      return NextResponse.json(
        { error: "Channel ID is required", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    // Check for duplicate channel name when renaming
    if (name !== undefined) {
      const existingByName = await prisma.channel.findFirst({
        where: { name, id: { not: id } },
        select: { id: true },
      });
      if (existingByName) {
        return NextResponse.json(
          { error: "渠道名称已存在", code: "DUPLICATE_NAME" },
          { status: 409 }
        );
      }
    }

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (baseUrl !== undefined) updateData.baseUrl = baseUrl.replace(/\/$/, "");
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (proxy !== undefined) updateData.proxy = proxy || null;
    if (enabled !== undefined) updateData.enabled = Boolean(enabled);
    if (keyMode !== undefined) updateData.keyMode = keyMode;
    if (routeStrategy !== undefined) updateData.routeStrategy = routeStrategy;

    const channel = await prisma.$transaction(async (tx) => {
      const updatedChannel = await tx.channel.update({
        where: { id },
        data: updateData,
      });

      // Update keys for multi-key mode
      if (keyMode === "multi" && keys !== undefined && typeof keys === "string") {
        await tx.channelKey.deleteMany({ where: { channelId: id } });
        // Parse and create new keys, skip first key (already saved as main apiKey)
        const keyList = keys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
        const extraKeys = keyList.slice(1);
        if (extraKeys.length > 0) {
          await tx.channelKey.createMany({
            data: extraKeys.map((k: string) => ({
              channelId: id,
              apiKey: k,
            })),
          });
        }
      } else if (keyMode === "single") {
        // Switching to single mode should clear stale extra keys.
        await tx.channelKey.deleteMany({ where: { channelId: id } });
      }

      return updatedChannel;
    });

    return NextResponse.json({
      success: true,
      channel: {
        ...channel,
        apiKey: channel.apiKey.slice(0, 8) + "...",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update channel", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}

// DELETE /api/channel - Delete channel
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "Channel ID is required", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    // Get channel info before deletion (for WebDAV sync)
    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "Channel not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    await prisma.channel.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete channel", code: "DELETE_ERROR" },
      { status: 500 }
    );
  }
}
