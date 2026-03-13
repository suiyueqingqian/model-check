// Channel Export API - Export all channels configuration

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import type { SiteBackupData } from "@/lib/site-backup";
import { buildSiteBackupData } from "@/lib/site-backup";

export type ChannelExportData = SiteBackupData;

// GET /api/channel/export - Export all channels
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(await buildSiteBackupData());
  } catch {
    return NextResponse.json(
      { error: "Failed to export channels", code: "EXPORT_ERROR" },
      { status: 500 }
    );
  }
}
