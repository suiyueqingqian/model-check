// WebDAV incremental sync utilities
// Handles append/delete operations for individual channels

import { buildSiteBackupData, type SiteBackupData } from "@/lib/site-backup";

// 内存互斥锁，串行化 WebDAV 写操作，防止并发读-改-写导致数据丢失
let webdavLock: Promise<void> = Promise.resolve();
function withWebDAVLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = webdavLock;
  let resolve: () => void;
  webdavLock = new Promise(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

interface WebDAVConfig {
  url: string;
  username?: string;
  password?: string;
  filename?: string;
}

interface ChannelData {
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy?: string | null;
  enabled?: boolean;
  keyMode?: string;
  routeStrategy?: string;
  channelKeys?: { apiKey: string; name: string | null }[];
}

// Get WebDAV config from environment variables
function getWebDAVConfig(): WebDAVConfig | null {
  const url = process.env.WEBDAV_URL;
  if (!url) return null;

  return {
    url,
    username: process.env.WEBDAV_USERNAME,
    password: process.env.WEBDAV_PASSWORD,
    filename: process.env.WEBDAV_FILENAME || "channels.json",
  };
}

// Check if WebDAV is configured
export function isWebDAVConfigured(): boolean {
  return !!process.env.WEBDAV_URL;
}

// Build WebDAV headers with auth
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

// Build full WebDAV URL
function buildWebDAVUrl(config: WebDAVConfig): string {
  let url = config.url.replace(/\/$/, "");
  const filename = config.filename || "channels.json";
  if (!url.endsWith(filename)) {
    url = `${url}/${filename}`;
  }
  return url;
}

// Ensure parent directories exist
async function ensureParentDirectories(baseUrl: string, filename: string, headers: HeadersInit): Promise<void> {
  const filenameParts = filename.split("/").filter(Boolean);
  filenameParts.pop();

  if (filenameParts.length === 0) return;

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  let currentPath = normalizedBaseUrl;

  for (const part of filenameParts) {
    currentPath += "/" + part;
    const dirUrl = currentPath.endsWith("/") ? currentPath : currentPath + "/";

    try {
      await fetch(dirUrl, {
        method: "MKCOL",
        headers: {
          ...headers,
          "Content-Type": "application/xml",
        },
      });
    } catch {
      // Ignore errors, let PUT fail if there's a real issue
    }
  }
}

// Write data to WebDAV
async function writeRemoteData(config: WebDAVConfig, data: SiteBackupData): Promise<boolean> {
  const webdavUrl = buildWebDAVUrl(config);
  const headers = buildWebDAVHeaders(config);

  try {
    await ensureParentDirectories(config.url, config.filename || "channels.json", headers);

    const response = await fetch(webdavUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(data, null, 2),
    });

    if (!response.ok) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Append a channel to WebDAV (called after channel creation)
 * If a channel with same baseUrl+apiKey exists, overwrite it
 */
export async function appendChannelToWebDAV(channel: ChannelData): Promise<void> {
  return withWebDAVLock(async () => {
    void channel;
    await syncAllChannelsToWebDAV();
  });
}

/**
 * Removes by matching name (primary) or baseUrl+apiKey (fallback)
 */
export async function removeChannelFromWebDAV(channel: ChannelData): Promise<void> {
  return withWebDAVLock(async () => {
    void channel;
    await syncAllChannelsToWebDAV();
  });
}

/**
 * Update a channel in WebDAV (called after channel update)
 * Updates by matching name (primary) or baseUrl+apiKey (fallback)
 */
export async function updateChannelInWebDAV(channel: ChannelData): Promise<void> {
  return withWebDAVLock(async () => {
    void channel;
    await syncAllChannelsToWebDAV();
  });
}

/**
 * Sync all channels to WebDAV (full replace mode)
 * Used after batch import to ensure WebDAV matches local state
 */
export async function syncAllChannelsToWebDAV(_channels?: ChannelData[]): Promise<void> {
  return withWebDAVLock(async () => {
    void _channels;
    const config = getWebDAVConfig();
    if (!config) {
      return;
    }

    const exportData = await buildSiteBackupData();
    const success = await writeRemoteData(config, exportData);
    if (!success) {
      throw new Error("Failed to sync all channels to WebDAV");
    }
  });
}
