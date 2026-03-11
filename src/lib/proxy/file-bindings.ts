import { getRedisClient } from "@/lib/redis";

const FILE_BINDING_PREFIX = "proxy:file-binding:";
const FILE_BINDING_TTL_SECONDS = 60 * 60 * 24 * 30;
const fileBindingFallback = new Map<string, { binding: ProxyFileBinding; expiresAt: number }>();

export interface ProxyFileBinding {
  channelId: string;
  channelKeyId: string | null;
  requestedModel: string;
  actualModelName: string;
  createdAt: string;
}

export function extractProxyFileReferences(
  value: unknown,
  result = new Set<string>()
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      extractProxyFileReferences(item, result);
    }
    return result;
  }

  if (!value || typeof value !== "object") {
    return result;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if ((key === "file_id" || key === "file_uri") && typeof item === "string" && item.trim()) {
      result.add(item.trim());
      continue;
    }
    extractProxyFileReferences(item, result);
  }

  return result;
}

export function buildProxyFileBindingKey(binding: ProxyFileBinding): string {
  return binding.channelKeyId ? `key:${binding.channelKeyId}` : `channel:${binding.channelId}`;
}

function getFallbackBinding(fileId: string): ProxyFileBinding | null {
  const cached = fileBindingFallback.get(fileId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    fileBindingFallback.delete(fileId);
    return null;
  }

  return cached.binding;
}

export async function setProxyFileBinding(fileId: string, binding: ProxyFileBinding): Promise<void> {
  const normalizedFileId = fileId.trim();
  if (!normalizedFileId) {
    return;
  }

  const payload = JSON.stringify(binding);
  const expiresAt = Date.now() + FILE_BINDING_TTL_SECONDS * 1000;

  try {
    await getRedisClient().set(
      `${FILE_BINDING_PREFIX}${normalizedFileId}`,
      payload,
      "EX",
      FILE_BINDING_TTL_SECONDS
    );
    return;
  } catch {
  }

  fileBindingFallback.set(normalizedFileId, { binding, expiresAt });
}

export async function getProxyFileBinding(fileId: string): Promise<ProxyFileBinding | null> {
  const normalizedFileId = fileId.trim();
  if (!normalizedFileId) {
    return null;
  }

  try {
    const raw = await getRedisClient().get(`${FILE_BINDING_PREFIX}${normalizedFileId}`);
    if (!raw) {
      return getFallbackBinding(normalizedFileId);
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const binding = parsed as Partial<ProxyFileBinding>;
    if (
      typeof binding.channelId !== "string" ||
      typeof binding.requestedModel !== "string" ||
      typeof binding.actualModelName !== "string" ||
      typeof binding.createdAt !== "string"
    ) {
      return null;
    }

    return {
      channelId: binding.channelId,
      channelKeyId: typeof binding.channelKeyId === "string" ? binding.channelKeyId : null,
      requestedModel: binding.requestedModel,
      actualModelName: binding.actualModelName,
      createdAt: binding.createdAt,
    };
  } catch {
    return getFallbackBinding(normalizedFileId);
  }
}
