// WebDAV Sync API - Sync channels to/from WebDAV server

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import type { ChannelExportData } from "../export/route";
import {
  buildSiteBackupData,
  importSiteBackupData,
  mergeSiteBackupData,
  parseSiteBackupData,
} from "@/lib/site-backup";

// Environment variables for WebDAV configuration
const ENV_WEBDAV_URL = process.env.WEBDAV_URL;
const ENV_WEBDAV_USERNAME = process.env.WEBDAV_USERNAME;
const ENV_WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD;
const ENV_WEBDAV_FILENAME = process.env.WEBDAV_FILENAME;
interface WebDAVConfig {
  url: string;
  username?: string;
  password?: string;
  filename?: string;
}

// Helper function to build WebDAV headers
function buildWebDAVHeaders(config: WebDAVConfig): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (config.username && config.password) {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;
  }

  return headers;
}

// Helper function to build full WebDAV URL
function buildWebDAVUrl(config: WebDAVConfig): string {
  let url = config.url.replace(/\/$/, "");
  const filename = config.filename || "channels.json";
  if (!url.endsWith(filename)) {
    url = `${url}/${filename}`;
  }
  return url;
}

// Helper function to ensure parent directories exist
// baseUrl: the WebDAV base URL (e.g., https://dav.jianguoyun.com/dav)
// filename: the filename which may contain subdirectories (e.g., "subdir/file.json")
async function ensureParentDirectories(baseUrl: string, filename: string, headers: HeadersInit): Promise<void> {
  // Extract subdirectory path from filename (e.g., "subdir/file.json" -> ["subdir"])
  const filenameParts = filename.split("/").filter(Boolean);

  // Remove the actual filename, keeping only directory parts
  filenameParts.pop();

  if (filenameParts.length === 0) {
    return; // No subdirectories in filename, nothing to create
  }

  // Normalize base URL (remove trailing slash)
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  // Create each subdirectory level under the base URL
  let currentPath = normalizedBaseUrl;
  for (const part of filenameParts) {
    currentPath += "/" + part;
    // Ensure directory URL ends with / for MKCOL
    const dirUrl = currentPath.endsWith("/") ? currentPath : currentPath + "/";

    try {
      // Try to create directory with MKCOL
      const response = await fetch(dirUrl, {
        method: "MKCOL",
        headers: {
          ...headers,
          "Content-Type": "application/xml", // Some WebDAV servers require this for MKCOL
        },
      });

      // 201 = Created, 405 = Already exists (Method Not Allowed)
      // 301/302 = Redirect (坚果云 already exists)
      // 409 = Conflict (坚果云 already exists or parent missing)
      if (response.ok || response.status === 201 || response.status === 405 ||
          response.status === 301 || response.status === 302 || response.status === 409) {
      } else if (response.status === 401) {
        throw new Error(`WebDAV authentication failed: invalid credentials`);
      } else if (response.status === 403) {
        // 403 on MKCOL usually means directory already exists or is the root sync folder
        // Try to continue - the actual PUT will fail if there's a real permission issue
      } else {
      }
    } catch {
      // Network errors should be logged but not thrown - let PUT fail with clearer error
    }
  }
}

// GET /api/channel/webdav - Get WebDAV config status
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  // Return config status (masked for security)
  return NextResponse.json({
    configured: !!(ENV_WEBDAV_URL && ENV_WEBDAV_USERNAME && ENV_WEBDAV_PASSWORD),
    url: ENV_WEBDAV_URL || "",
    username: ENV_WEBDAV_USERNAME || "",
    hasPassword: !!ENV_WEBDAV_PASSWORD,
    filename: ENV_WEBDAV_FILENAME || "channels.json",
  });
}

// POST /api/channel/webdav - Sync with WebDAV
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action, url, username, password, filename, mode = "merge" } = body as {
      action: "upload" | "download";
      url?: string;
      username?: string;
      password?: string;
      filename?: string;
      mode?: "merge" | "replace";
    };

    // Use environment variables as fallback (empty string also falls back to env)
    const finalUrl = url || ENV_WEBDAV_URL;
    const finalUsername = username || ENV_WEBDAV_USERNAME;
    const finalPassword = password || ENV_WEBDAV_PASSWORD;
    const finalFilename = filename || ENV_WEBDAV_FILENAME;

    // Debug logging (remove in production)

    if (!action || !finalUrl) {
      return NextResponse.json(
        { error: "Action and URL are required (set WEBDAV_URL env or provide in request)", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const config: WebDAVConfig = {
      url: finalUrl,
      username: finalUsername,
      password: finalPassword,
      filename: finalFilename
    };
    const webdavUrl = buildWebDAVUrl(config);
    const headers = buildWebDAVHeaders(config);

    if (action === "upload") {
      const localBackup = await buildSiteBackupData();
      let finalBackup = localBackup;
      let merged = 0;
      let replaced = 0;

      if (mode === "merge") {
        try {
          const downloadResponse = await fetch(webdavUrl, {
            method: "GET",
            headers,
          });

          if (downloadResponse.ok) {
            const remoteBackup = await parseSiteBackupData((await downloadResponse.json()) as ChannelExportData);
            finalBackup = mergeSiteBackupData(localBackup, remoteBackup);
            merged = Math.max(0, finalBackup.channels.length - localBackup.channels.length);
          }
        } catch {
          finalBackup = localBackup;
        }
      } else {
        replaced = 1;
      }

      await ensureParentDirectories(finalUrl, finalFilename || "channels.json", headers);

      const response = await fetch(webdavUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(finalBackup, null, 2),
      });

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        const text = await response.text().catch(() => "");
        throw new Error(`WebDAV upload failed: ${response.status} ${response.statusText} ${text}`);
      }

      return NextResponse.json({
        success: true,
        action: "upload",
        mode,
        localCount: localBackup.channels.length,
        mergedFromRemote: merged,
        totalUploaded: finalBackup.channels.length,
        replaced: replaced === 1,
        url: webdavUrl,
      });
    } else if (action === "download") {
      const response = await fetch(webdavUrl, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return NextResponse.json(
            { error: "Remote file not found", code: "NOT_FOUND" },
            { status: 404 }
          );
        }
        throw new Error(`WebDAV download failed: ${response.status} ${response.statusText}`);
      }

      const data = await parseSiteBackupData((await response.json()) as ChannelExportData);
      const result = await importSiteBackupData(data, mode);

      return NextResponse.json({
        success: true,
        action: "download",
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        duplicates: result.duplicates,
        total: result.total,
        importedChannels: result.importedChannels,
        schedulerConfigRestored: data.schedulerConfig !== null,
        proxyKeysRestored: data.proxyKeys.length,
        remoteVersion: data.version,
        remoteExportedAt: data.exportedAt,
      });
    }

    return NextResponse.json(
      { error: "Invalid action", code: "INVALID_ACTION" },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "WebDAV sync failed";
    return NextResponse.json(
      { error: message, code: "WEBDAV_ERROR" },
      { status: 500 }
    );
  }
}
