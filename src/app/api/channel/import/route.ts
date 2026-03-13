// Channel Import API - Import channels from configuration

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { syncAllChannelsToWebDAV, isWebDAVConfigured } from "@/lib/webdav/sync";
import type { ChannelExportData } from "../export/route";
import { importSiteBackupData, parseSiteBackupData } from "@/lib/site-backup";

// POST /api/channel/import - Import channels
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { mode = "merge" } = body as {
      mode?: "merge" | "replace";
    };
    const backupData = await parseSiteBackupData(body as ChannelExportData);
    const result = await importSiteBackupData(backupData, mode);

    // Sync to WebDAV if configured
    const webdavStatus = { synced: false, error: null as string | null };
    if (isWebDAVConfigured() && result.total > 0) {
      try {
        await syncAllChannelsToWebDAV();
        webdavStatus.synced = true;
      } catch (err) {
        webdavStatus.error = err instanceof Error ? err.message : "WebDAV sync failed";
      }
    }

    return NextResponse.json({
      success: true,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
      duplicates: result.duplicates,
      total: result.total,
      webdav: webdavStatus,
      importedChannels: result.importedChannels,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to import channels", code: "IMPORT_ERROR" },
      { status: 500 }
    );
  }
}
