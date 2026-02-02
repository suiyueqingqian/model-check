// Channel Import API - Import channels from configuration

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";
import type { ChannelExportData } from "../export/route";

// POST /api/channel/import - Import channels
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { channels, mode = "merge", syncModels = true } = body as {
      channels?: ChannelExportData["channels"];
      mode?: "merge" | "replace";
      syncModels?: boolean;
    };

    // Support both direct channels array and full export format
    const channelsToImport = channels || (body as ChannelExportData).channels;

    if (!channelsToImport || !Array.isArray(channelsToImport)) {
      return NextResponse.json(
        { error: "Invalid import data: channels array required", code: "INVALID_DATA" },
        { status: 400 }
      );
    }

    // Validate channels
    for (const ch of channelsToImport) {
      if (!ch.name || !ch.baseUrl || !ch.apiKey) {
        return NextResponse.json(
          { error: `Invalid channel data: name, baseUrl, and apiKey are required`, code: "INVALID_DATA" },
          { status: 400 }
        );
      }
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let duplicates = 0;
    const importedChannelIds: string[] = [];

    // If replace mode, delete all existing channels first
    if (mode === "replace") {
      await prisma.channel.deleteMany({});
    }

    // Build set of existing channels by baseUrl+apiKey for duplicate detection
    const existingChannels = await prisma.channel.findMany({
      select: { id: true, name: true, baseUrl: true, apiKey: true },
    });
    const existingKeySet = new Set(
      existingChannels.map((ch) => `${ch.baseUrl.replace(/\/$/, "")}|${ch.apiKey}`)
    );

    // Also track duplicates within the import data itself
    const importKeySet = new Set<string>();

    for (const ch of channelsToImport) {
      const normalizedBaseUrl = ch.baseUrl.replace(/\/$/, "");
      const channelKey = `${normalizedBaseUrl}|${ch.apiKey}`;

      // Check for duplicate within import data
      if (importKeySet.has(channelKey)) {
        duplicates++;
        continue;
      }
      importKeySet.add(channelKey);

      // Check for duplicate with existing channels (by baseUrl+apiKey)
      if (mode !== "replace" && existingKeySet.has(channelKey)) {
        // Find existing channel with same baseUrl+apiKey
        const existingByKey = existingChannels.find(
          (ec) => `${ec.baseUrl.replace(/\/$/, "")}|${ec.apiKey}` === channelKey
        );
        if (existingByKey) {
          duplicates++;
          continue;
        }
      }

      // Check if channel with same name exists
      const existing = await prisma.channel.findFirst({
        where: { name: ch.name },
      });

      if (existing) {
        if (mode === "merge") {
          // Update existing channel
          await prisma.channel.update({
            where: { id: existing.id },
            data: {
              baseUrl: normalizedBaseUrl,
              apiKey: ch.apiKey,
              proxy: ch.proxy || null,
              enabled: ch.enabled ?? true,
            },
          });
          importedChannelIds.push(existing.id);
          updated++;
        } else {
          skipped++;
        }
      } else {
        // Create new channel
        const newChannel = await prisma.channel.create({
          data: {
            name: ch.name,
            baseUrl: normalizedBaseUrl,
            apiKey: ch.apiKey,
            proxy: ch.proxy || null,
            enabled: ch.enabled ?? true,
          },
        });
        importedChannelIds.push(newChannel.id);
        imported++;
      }
    }

    // Auto-sync models for imported channels
    let syncedModels = 0;
    const syncErrors: string[] = [];

    if (syncModels && importedChannelIds.length > 0) {
      // Sync models in parallel (with concurrency limit)
      const CONCURRENCY = 3;
      for (let i = 0; i < importedChannelIds.length; i += CONCURRENCY) {
        const batch = importedChannelIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((channelId) => syncChannelModels(channelId))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "fulfilled") {
            syncedModels += result.value.added;
          } else {
            console.error(`[API] Sync models error for channel ${batch[j]}:`, result.reason);
            syncErrors.push(batch[j]);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      updated,
      skipped,
      duplicates,
      total: channelsToImport.length,
      syncedModels,
      syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
    });
  } catch (error) {
    console.error("[API] Import channels error:", error);
    return NextResponse.json(
      { error: "Failed to import channels", code: "IMPORT_ERROR" },
      { status: 500 }
    );
  }
}
