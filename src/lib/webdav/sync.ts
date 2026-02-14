// WebDAV incremental sync utilities
// Handles append/delete operations for individual channels

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

interface WebDAVExportData {
  version: string;
  exportedAt: string;
  channels: ChannelData[];
  schedulerConfig?: Record<string, unknown>;
  proxyKeys?: Array<Record<string, unknown>>;
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

// Read remote WebDAV data
async function readRemoteData(config: WebDAVConfig): Promise<WebDAVExportData | null> {
  const webdavUrl = buildWebDAVUrl(config);
  const headers = buildWebDAVHeaders(config);

  try {
    const response = await fetch(webdavUrl, {
      method: "GET",
      headers,
    });

    if (response.status === 404) {
      // No remote file yet, return empty structure
      return {
        version: "2.0",
        exportedAt: new Date().toISOString(),
        channels: [],
      };
    }

    if (!response.ok) {
      return null;
    }

    return await response.json() as WebDAVExportData;
  } catch (error) {
    return null;
  }
}

// Write data to WebDAV
async function writeRemoteData(config: WebDAVConfig, data: WebDAVExportData): Promise<boolean> {
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
  } catch (error) {
    return false;
  }
}

/**
 * Generate a unique channel name by appending numeric suffix
 * Example: "channel" -> "channel-1" -> "channel-2" ...
 */
function generateUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

/**
 * Append a channel to WebDAV (called after channel creation)
 * If a channel with same baseUrl+apiKey exists, overwrite it
 */
export async function appendChannelToWebDAV(channel: ChannelData): Promise<void> {
  const config = getWebDAVConfig();
  if (!config) {
    return;
  }

  const remoteData = await readRemoteData(config);
  if (!remoteData) {
    throw new Error("Failed to read remote data for append");
  }

  const channelKey = `${channel.baseUrl.replace(/\/$/, "")}|${channel.apiKey}`;

  // Check if channel with same baseUrl+apiKey already exists
  const existingIndex = remoteData.channels.findIndex((ch) => {
    const key = `${ch.baseUrl.replace(/\/$/, "")}|${ch.apiKey}`;
    return key === channelKey;
  });

  if (existingIndex >= 0) {
    // Overwrite existing entry
    remoteData.channels[existingIndex] = {
      name: channel.name,
      baseUrl: channel.baseUrl.replace(/\/$/, ""),
      apiKey: channel.apiKey,
      proxy: channel.proxy || null,
      enabled: channel.enabled ?? true,
      ...(channel.keyMode && { keyMode: channel.keyMode }),
      ...(channel.routeStrategy && { routeStrategy: channel.routeStrategy }),
      ...(channel.channelKeys?.length && { channelKeys: channel.channelKeys }),
    };
  } else {
    // New channel - check for name conflict
    const existingNames = new Set(remoteData.channels.map((ch) => ch.name));
    const finalName = generateUniqueName(channel.name, existingNames);

    remoteData.channels.push({
      name: finalName,
      baseUrl: channel.baseUrl.replace(/\/$/, ""),
      apiKey: channel.apiKey,
      proxy: channel.proxy || null,
      enabled: channel.enabled ?? true,
      ...(channel.keyMode && { keyMode: channel.keyMode }),
      ...(channel.routeStrategy && { routeStrategy: channel.routeStrategy }),
      ...(channel.channelKeys?.length && { channelKeys: channel.channelKeys }),
    });
  }

  remoteData.exportedAt = new Date().toISOString();

  const success = await writeRemoteData(config, remoteData);
  if (!success) {
    throw new Error("Failed to write channel data to WebDAV");
  }
}

/**
 * Remove a channel from WebDAV (called after channel deletion)
 * Removes by matching name (primary) or baseUrl+apiKey (fallback)
 */
export async function removeChannelFromWebDAV(channel: ChannelData): Promise<void> {
  const config = getWebDAVConfig();
  if (!config) {
    return;
  }

  const remoteData = await readRemoteData(config);
  if (!remoteData) {
    throw new Error("Failed to read remote data for remove");
  }

  const originalLength = remoteData.channels.length;
  const channelKey = `${channel.baseUrl.replace(/\/$/, "")}|${channel.apiKey}`;

  remoteData.channels = remoteData.channels.filter((ch) => {
    // Match by name (primary)
    if (ch.name === channel.name) {
      return false;
    }
    // Match by baseUrl+apiKey (fallback)
    const key = `${ch.baseUrl.replace(/\/$/, "")}|${ch.apiKey}`;
    return key !== channelKey;
  });

  if (remoteData.channels.length === originalLength) {
    return;
  }

  remoteData.exportedAt = new Date().toISOString();

  const success = await writeRemoteData(config, remoteData);
  if (!success) {
    throw new Error("Failed to write channel data to WebDAV");
  }
}

/**
 * Update a channel in WebDAV (called after channel update)
 * Updates by matching name (primary) or baseUrl+apiKey (fallback)
 */
export async function updateChannelInWebDAV(channel: ChannelData): Promise<void> {
  const config = getWebDAVConfig();
  if (!config) {
    return;
  }

  const remoteData = await readRemoteData(config);
  if (!remoteData) {
    throw new Error("Failed to read remote data for update");
  }

  const normalizedBaseUrl = channel.baseUrl.replace(/\/$/, "");
  const channelKey = `${normalizedBaseUrl}|${channel.apiKey}`;

  // Match by name first to avoid duplication when apiKey changes.
  let existingIndex = remoteData.channels.findIndex((ch) => ch.name === channel.name);
  if (existingIndex < 0) {
    // Fallback: match by baseUrl+apiKey
    existingIndex = remoteData.channels.findIndex((ch) => {
      const key = `${ch.baseUrl.replace(/\/$/, "")}|${ch.apiKey}`;
      return key === channelKey;
    });
  }

  if (existingIndex >= 0) {
    // Update existing entry
    remoteData.channels[existingIndex] = {
      name: channel.name,
      baseUrl: normalizedBaseUrl,
      apiKey: channel.apiKey,
      proxy: channel.proxy || null,
      enabled: channel.enabled ?? true,
      ...(channel.keyMode && { keyMode: channel.keyMode }),
      ...(channel.routeStrategy && { routeStrategy: channel.routeStrategy }),
      ...(channel.channelKeys?.length && { channelKeys: channel.channelKeys }),
    };
  } else {
    // Channel doesn't exist remotely - append it
    const existingNames = new Set(remoteData.channels.map((ch) => ch.name));
    const finalName = generateUniqueName(channel.name, existingNames);

    remoteData.channels.push({
      name: finalName,
      baseUrl: normalizedBaseUrl,
      apiKey: channel.apiKey,
      proxy: channel.proxy || null,
      enabled: channel.enabled ?? true,
      ...(channel.keyMode && { keyMode: channel.keyMode }),
      ...(channel.routeStrategy && { routeStrategy: channel.routeStrategy }),
      ...(channel.channelKeys?.length && { channelKeys: channel.channelKeys }),
    });
  }

  remoteData.exportedAt = new Date().toISOString();

  const success = await writeRemoteData(config, remoteData);
  if (!success) {
    throw new Error("Failed to write channel data to WebDAV");
  }
}

/**
 * Sync all channels to WebDAV (full replace mode)
 * Used after batch import to ensure WebDAV matches local state
 */
export async function syncAllChannelsToWebDAV(channels: ChannelData[]): Promise<void> {
  const config = getWebDAVConfig();
  if (!config) {
    return;
  }

  // Read existing remote data to preserve schedulerConfig and proxyKeys
  const remoteData = await readRemoteData(config);
  const baseData: WebDAVExportData = remoteData || {
    version: "2.0",
    exportedAt: new Date().toISOString(),
    channels: [],
  };

  // Replace channels with the new list
  baseData.channels = channels.map((ch) => ({
    name: ch.name,
    baseUrl: ch.baseUrl.replace(/\/$/, ""),
    apiKey: ch.apiKey,
    proxy: ch.proxy || null,
    enabled: ch.enabled ?? true,
    ...(ch.keyMode && { keyMode: ch.keyMode }),
    ...(ch.routeStrategy && { routeStrategy: ch.routeStrategy }),
    ...(ch.channelKeys?.length && { channelKeys: ch.channelKeys }),
  }));
  baseData.exportedAt = new Date().toISOString();

  const success = await writeRemoteData(config, baseData);
  if (!success) {
    throw new Error("Failed to sync all channels to WebDAV");
  }
}
