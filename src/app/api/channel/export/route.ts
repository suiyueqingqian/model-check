// Channel Export API - Export all channels configuration

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

export interface ChannelExportData {
  version: string;
  exportedAt: string;
  channels: {
    name: string;
    baseUrl: string;
    apiKey: string;
    proxy: string | null;
    enabled: boolean;
    keyMode?: string;
    routeStrategy?: string;
    channelKeys?: { apiKey: string; name: string | null }[];
  }[];
}

// GET /api/channel/export - Export all channels
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const channels = await prisma.channel.findMany({
      select: {
        name: true,
        baseUrl: true,
        apiKey: true,
        proxy: true,
        enabled: true,
        keyMode: true,
        routeStrategy: true,
        channelKeys: {
          select: { apiKey: true, name: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const exportData: ChannelExportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      channels: channels.map((ch) => ({
        name: ch.name,
        baseUrl: ch.baseUrl,
        apiKey: ch.apiKey,
        proxy: ch.proxy,
        enabled: ch.enabled,
        keyMode: ch.keyMode,
        routeStrategy: ch.routeStrategy,
        ...(ch.channelKeys.length > 0 && {
          channelKeys: ch.channelKeys.map((k) => ({
            apiKey: k.apiKey,
            name: k.name,
          })),
        }),
      })),
    };

    return NextResponse.json(exportData);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to export channels", code: "EXPORT_ERROR" },
      { status: 500 }
    );
  }
}
