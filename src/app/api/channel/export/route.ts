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
      })),
    };

    return NextResponse.json(exportData);
  } catch (error) {
    console.error("[API] Export channels error:", error);
    return NextResponse.json(
      { error: "Failed to export channels", code: "EXPORT_ERROR" },
      { status: 500 }
    );
  }
}
