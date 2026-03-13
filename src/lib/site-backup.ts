import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { BUILTIN_PROXY_KEY_DB_ID } from "@/lib/utils/proxy-key";
import { normalizeChannelKeyMode } from "@/lib/channel/key-mode";
import { reloadWorkerConfig } from "@/lib/queue/worker";

export const SITE_BACKUP_VERSION = "2.0";

type JsonRecord = Record<string, unknown>;

export interface BackupChannelKeyData {
  apiKey: string;
  name: string | null;
}

export interface BackupModelRef {
  channelName: string;
  modelName: string;
  channelKeyIndex: number | null;
}

export interface BackupChannelModelData {
  modelName: string;
  channelKeyIndex: number | null;
  detectedEndpoints: string[];
  preferredProxyEndpoint: string | null;
}

export interface BackupChannelData {
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  enabled: boolean;
  sortOrder: number;
  keyMode: "single" | "multi";
  routeStrategy: string;
  channelKeys: BackupChannelKeyData[];
  models: BackupChannelModelData[];
}

export interface BackupSchedulerConfigData {
  enabled: boolean;
  cronSchedule: string;
  timezone: string;
  channelConcurrency: number;
  maxGlobalConcurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  detectAllChannels: boolean;
  selectedChannelNames: string[];
  selectedModels: BackupModelRef[];
}

export interface BackupProxyKeyData {
  name: string;
  key: string;
  enabled: boolean;
  allowAllModels: boolean;
  allowedChannelNames: string[];
  allowedModels: BackupModelRef[];
  unifiedMode: boolean;
  allowedUnifiedModels: string[];
  temporaryStopValue: number;
  temporaryStopUnit: string;
  unifiedRouteStrategy: string;
  builtin: boolean;
}

export interface BackupKeywordData {
  keyword: string;
  enabled: boolean;
}

export interface SiteBackupData {
  version: string;
  exportedAt: string;
  channels: BackupChannelData[];
  schedulerConfig: BackupSchedulerConfigData | null;
  proxyKeys: BackupProxyKeyData[];
  modelKeywords: BackupKeywordData[];
}

export interface ImportSiteBackupResult {
  imported: number;
  updated: number;
  skipped: number;
  duplicates: number;
  total: number;
  importedChannels: { id: string; name: string }[];
}

type NormalizedBackupChannelInput = BackupChannelData;
type NormalizedSchedulerConfigInput = BackupSchedulerConfigData | null;
type NormalizedProxyKeyInput = BackupProxyKeyData;
type RestoredChannelResult = {
  channelId: string;
  channelName: string;
  modelIdByRefKey: Map<string, string>;
};

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function buildModelRefKey(ref: BackupModelRef): string {
  return `${ref.channelName}\u0000${ref.modelName}\u0000${ref.channelKeyIndex ?? "__main__"}`;
}

function buildChannelModelRef(
  channelName: string,
  modelName: string,
  channelKeyIndex: number | null
): BackupModelRef {
  return { channelName, modelName, channelKeyIndex };
}

function uniqueModelRefs(refs: BackupModelRef[]): BackupModelRef[] {
  const uniqueRefs = new Map<string, BackupModelRef>();
  for (const ref of refs) {
    uniqueRefs.set(buildModelRefKey(ref), ref);
  }
  return Array.from(uniqueRefs.values());
}

function toJsonNullIfEmptyStringArray(
  values: string[]
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return values.length > 0 ? values : Prisma.JsonNull;
}

function normalizeChannelKeys(
  mainApiKey: string,
  channelKeys: unknown
): BackupChannelKeyData[] {
  if (!Array.isArray(channelKeys)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedKeys: BackupChannelKeyData[] = [];

  for (const item of channelKeys) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as JsonRecord;
    const apiKey = parseNullableString(record.apiKey);
    if (!apiKey || apiKey === mainApiKey || seen.has(apiKey)) {
      continue;
    }
    seen.add(apiKey);
    normalizedKeys.push({
      apiKey,
      name: parseNullableString(record.name),
    });
  }

  return normalizedKeys;
}

function normalizeChannelModels(models: unknown, channelKeys: BackupChannelKeyData[]): BackupChannelModelData[] {
  if (!Array.isArray(models)) {
    return [];
  }

  const normalizedModels: BackupChannelModelData[] = [];
  const seen = new Set<string>();

  for (const item of models) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as JsonRecord;
    const modelName = parseNullableString(record.modelName);
    if (!modelName) {
      continue;
    }

    const rawKeyIndex = typeof record.channelKeyIndex === "number" && Number.isInteger(record.channelKeyIndex)
      ? record.channelKeyIndex
      : null;
    const channelKeyIndex =
      rawKeyIndex !== null && rawKeyIndex >= 0 && rawKeyIndex < channelKeys.length ? rawKeyIndex : null;
    const signature = `${modelName}\u0000${channelKeyIndex ?? "__main__"}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    normalizedModels.push({
      modelName,
      channelKeyIndex,
      detectedEndpoints: parseStringArray(record.detectedEndpoints),
      preferredProxyEndpoint: parseNullableString(record.preferredProxyEndpoint),
    });
  }

  return normalizedModels;
}

function normalizeBackupChannels(rawChannels: unknown): NormalizedBackupChannelInput[] {
  if (!Array.isArray(rawChannels)) {
    throw new Error("备份内容不合法：缺少 channels 数组");
  }

  const normalizedChannels: NormalizedBackupChannelInput[] = [];
  const seen = new Set<string>();

  for (const item of rawChannels) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as JsonRecord;
    const name = parseNullableString(record.name);
    const baseUrl = parseNullableString(record.baseUrl);
    const apiKey = parseNullableString(record.apiKey);
    if (!name || !baseUrl || !apiKey) {
      continue;
    }

    const normalizedChannelKeys = normalizeChannelKeys(apiKey, record.channelKeys);
    const normalizedKeyMode = normalizeChannelKeyMode(
      parseNullableString(record.keyMode),
      normalizedChannelKeys.length
    );
    const channelSignature = `${normalizeBaseUrl(baseUrl)}\u0000${apiKey}`;
    if (seen.has(channelSignature)) {
      continue;
    }
    seen.add(channelSignature);

    normalizedChannels.push({
      name,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      proxy: parseNullableString(record.proxy),
      enabled: parseBoolean(record.enabled, true),
      sortOrder: Math.trunc(parseNumber(record.sortOrder, 0)),
      keyMode: normalizedKeyMode,
      routeStrategy: parseNullableString(record.routeStrategy) || "round_robin",
      channelKeys: normalizedChannelKeys,
      models: normalizeChannelModels(record.models, normalizedChannelKeys),
    });
  }

  return normalizedChannels;
}

function normalizeBackupModelRefs(value: unknown): BackupModelRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueModelRefs(
    value
      .filter((item): item is JsonRecord => !!item && typeof item === "object")
      .map((item) => {
        const channelName = parseNullableString(item.channelName);
        const modelName = parseNullableString(item.modelName);
        const channelKeyIndex =
          typeof item.channelKeyIndex === "number" && Number.isInteger(item.channelKeyIndex)
            ? item.channelKeyIndex
            : null;
        if (!channelName || !modelName) {
          return null;
        }
        return buildChannelModelRef(channelName, modelName, channelKeyIndex);
      })
      .filter((item): item is BackupModelRef => item !== null)
  );
}

function normalizeSchedulerConfig(value: unknown): NormalizedSchedulerConfigInput {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as JsonRecord;
  return {
    enabled: parseBoolean(record.enabled, true),
    cronSchedule: parseNullableString(record.cronSchedule) || "0 0,8,12,16,20 * * *",
    timezone: parseNullableString(record.timezone) || "Asia/Shanghai",
    channelConcurrency: Math.max(1, Math.trunc(parseNumber(record.channelConcurrency, 5))),
    maxGlobalConcurrency: Math.max(1, Math.trunc(parseNumber(record.maxGlobalConcurrency, 30))),
    minDelayMs: Math.max(0, Math.trunc(parseNumber(record.minDelayMs, 3000))),
    maxDelayMs: Math.max(0, Math.trunc(parseNumber(record.maxDelayMs, 5000))),
    detectAllChannels: parseBoolean(record.detectAllChannels, true),
    selectedChannelNames: parseStringArray(record.selectedChannelNames),
    selectedModels: normalizeBackupModelRefs(record.selectedModels),
  };
}

function normalizeProxyKeys(value: unknown): NormalizedProxyKeyInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedKeys: NormalizedProxyKeyInput[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as JsonRecord;
    const name = parseNullableString(record.name);
    const key = parseNullableString(record.key);
    if (!name || !key) {
      continue;
    }

    const signature = `${record.builtin === true ? "__builtin__" : key}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    normalizedKeys.push({
      name,
      key,
      enabled: parseBoolean(record.enabled, true),
      allowAllModels: parseBoolean(record.allowAllModels, true),
      allowedChannelNames: parseStringArray(record.allowedChannelNames),
      allowedModels: normalizeBackupModelRefs(record.allowedModels),
      unifiedMode: parseBoolean(record.unifiedMode, true),
      allowedUnifiedModels: parseStringArray(record.allowedUnifiedModels),
      temporaryStopValue: Math.max(0, Math.trunc(parseNumber(record.temporaryStopValue, 10))),
      temporaryStopUnit: parseNullableString(record.temporaryStopUnit) || "minute",
      unifiedRouteStrategy: parseNullableString(record.unifiedRouteStrategy) || "round_robin",
      builtin: record.builtin === true,
    });
  }

  return normalizedKeys;
}

function normalizeKeywords(value: unknown): BackupKeywordData[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const keywords: BackupKeywordData[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as JsonRecord;
    const keyword = parseNullableString(record.keyword);
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    keywords.push({
      keyword,
      enabled: parseBoolean(record.enabled, true),
    });
  }
  return keywords;
}

function normalizeLegacySchedulerConfig(
  value: unknown,
  channelNameById: Map<string, string>,
  modelRefById: Map<string, BackupModelRef>
): NormalizedSchedulerConfigInput {
  const baseConfig = normalizeSchedulerConfig(value);
  if (!baseConfig) {
    return null;
  }

  const record = value as JsonRecord;
  const selectedChannelNames =
    baseConfig.selectedChannelNames.length > 0
      ? baseConfig.selectedChannelNames
      : parseStringArray(record.selectedChannelIds)
          .map((id) => channelNameById.get(id))
          .filter((name): name is string => Boolean(name));
  const selectedModels =
    baseConfig.selectedModels.length > 0
      ? baseConfig.selectedModels
      : uniqueModelRefs(
          Object.values((record.selectedModelIds ?? {}) as JsonRecord)
            .flatMap((item) => parseStringArray(item))
            .map((modelId) => modelRefById.get(modelId))
            .filter((ref): ref is BackupModelRef => Boolean(ref))
        );

  return {
    ...baseConfig,
    selectedChannelNames,
    selectedModels,
  };
}

function normalizeLegacyProxyKeys(
  value: unknown,
  channelNameById: Map<string, string>,
  modelRefById: Map<string, BackupModelRef>
): NormalizedProxyKeyInput[] {
  const proxyKeys = normalizeProxyKeys(value);
  if (proxyKeys.length === 0 && !Array.isArray(value)) {
    return [];
  }

  return proxyKeys.map((proxyKey, index) => {
    const record = Array.isArray(value) && value[index] && typeof value[index] === "object"
      ? (value[index] as JsonRecord)
      : null;
    if (!record) {
      return proxyKey;
    }

    const allowedChannelNames =
      proxyKey.allowedChannelNames.length > 0
        ? proxyKey.allowedChannelNames
        : parseStringArray(record.allowedChannelIds)
            .map((id) => channelNameById.get(id))
            .filter((name): name is string => Boolean(name));
    const allowedModels =
      proxyKey.allowedModels.length > 0
        ? proxyKey.allowedModels
        : uniqueModelRefs(
            parseStringArray(record.allowedModelIds)
              .map((modelId) => modelRefById.get(modelId))
              .filter((ref): ref is BackupModelRef => Boolean(ref))
          );

    return {
      ...proxyKey,
      allowedChannelNames,
      allowedModels,
    };
  });
}

async function restoreChannel(
  tx: Prisma.TransactionClient,
  input: NormalizedBackupChannelInput,
  existingChannelId?: string
): Promise<RestoredChannelResult> {
  const normalizedKeyMode = normalizeChannelKeyMode(input.keyMode, input.channelKeys.length);

  const channel = existingChannelId
    ? await tx.channel.update({
        where: { id: existingChannelId },
        data: {
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          proxy: input.proxy,
          enabled: input.enabled,
          sortOrder: input.sortOrder,
          keyMode: normalizedKeyMode,
          routeStrategy: input.routeStrategy,
          mainKeyLastValid: null,
          mainKeyLastCheckedAt: null,
        },
      })
    : await tx.channel.create({
        data: {
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          proxy: input.proxy,
          enabled: input.enabled,
          sortOrder: input.sortOrder,
          keyMode: normalizedKeyMode,
          routeStrategy: input.routeStrategy,
        },
      });

  await tx.channelKey.deleteMany({ where: { channelId: channel.id } });
  await tx.model.deleteMany({ where: { channelId: channel.id } });

  const createdChannelKeys = [];
  for (const channelKey of input.channelKeys) {
    const createdKey = await tx.channelKey.create({
      data: {
        channelId: channel.id,
        apiKey: channelKey.apiKey,
        name: channelKey.name,
        lastValid: null,
        lastCheckedAt: null,
      },
    });
    createdChannelKeys.push(createdKey);
  }

  const modelIdByRefKey = new Map<string, string>();
  for (const model of input.models) {
    const channelKeyId =
      model.channelKeyIndex !== null ? createdChannelKeys[model.channelKeyIndex]?.id ?? null : null;
    const createdModel = await tx.model.create({
      data: {
        channelId: channel.id,
        modelName: model.modelName,
        channelKeyId,
        detectedEndpoints: model.detectedEndpoints,
        preferredProxyEndpoint: model.preferredProxyEndpoint,
        lastStatus: null,
        lastLatency: null,
        lastCheckedAt: null,
      },
    });

    modelIdByRefKey.set(
      buildModelRefKey(buildChannelModelRef(input.name, model.modelName, model.channelKeyIndex)),
      createdModel.id
    );
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    modelIdByRefKey,
  };
}

export async function buildSiteBackupData(): Promise<SiteBackupData> {
  const [channels, schedulerConfig, proxyKeys, modelKeywords] = await Promise.all([
    prisma.channel.findMany({
      select: {
        id: true,
        name: true,
        baseUrl: true,
        apiKey: true,
        proxy: true,
        enabled: true,
        sortOrder: true,
        keyMode: true,
        routeStrategy: true,
        channelKeys: {
          select: {
            id: true,
            apiKey: true,
            name: true,
          },
          orderBy: [
            { createdAt: "asc" },
            { id: "asc" },
          ],
        },
        models: {
          select: {
            id: true,
            modelName: true,
            channelKeyId: true,
            detectedEndpoints: true,
            preferredProxyEndpoint: true,
          },
          orderBy: [
            { modelName: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
          ],
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }),
    prisma.schedulerConfig.findUnique({
      where: { id: "default" },
    }),
    prisma.proxyKey.findMany({
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }),
    prisma.modelKeyword.findMany({
      select: {
        keyword: true,
        enabled: true,
      },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }),
  ]);

  const channelNameById = new Map<string, string>();
  const modelRefById = new Map<string, BackupModelRef>();

  const exportedChannels = channels.map((channel) => {
    channelNameById.set(channel.id, channel.name);
    const keyIndexById = new Map(channel.channelKeys.map((key, index) => [key.id, index] as const));

    return {
      name: channel.name,
      baseUrl: normalizeBaseUrl(channel.baseUrl),
      apiKey: channel.apiKey,
      proxy: channel.proxy,
      enabled: channel.enabled,
      sortOrder: channel.sortOrder,
      keyMode: normalizeChannelKeyMode(channel.keyMode, channel.channelKeys.length),
      routeStrategy: channel.routeStrategy,
      channelKeys: channel.channelKeys.map((key) => ({
        apiKey: key.apiKey,
        name: key.name,
      })),
      models: channel.models.map((model) => {
        const channelKeyIndex = model.channelKeyId ? keyIndexById.get(model.channelKeyId) ?? null : null;
        modelRefById.set(
          model.id,
          buildChannelModelRef(channel.name, model.modelName, channelKeyIndex)
        );
        return {
          modelName: model.modelName,
          channelKeyIndex,
          detectedEndpoints: model.detectedEndpoints,
          preferredProxyEndpoint: model.preferredProxyEndpoint,
        };
      }),
    };
  });

  const exportedSchedulerConfig = schedulerConfig
    ? {
        enabled: schedulerConfig.enabled,
        cronSchedule: schedulerConfig.cronSchedule,
        timezone: schedulerConfig.timezone,
        channelConcurrency: schedulerConfig.channelConcurrency,
        maxGlobalConcurrency: schedulerConfig.maxGlobalConcurrency,
        minDelayMs: schedulerConfig.minDelayMs,
        maxDelayMs: schedulerConfig.maxDelayMs,
        detectAllChannels: schedulerConfig.detectAllChannels,
        selectedChannelNames: parseStringArray(schedulerConfig.selectedChannelIds)
          .map((channelId) => channelNameById.get(channelId))
          .filter((name): name is string => Boolean(name)),
        selectedModels: uniqueModelRefs(
          Object.values((schedulerConfig.selectedModelIds ?? {}) as JsonRecord)
            .flatMap((item) => parseStringArray(item))
            .map((modelId) => modelRefById.get(modelId))
            .filter((ref): ref is BackupModelRef => Boolean(ref))
        ),
      }
    : null;

  const exportedProxyKeys = proxyKeys.map((proxyKey) => ({
    name: proxyKey.name,
    key: proxyKey.key,
    enabled: proxyKey.enabled,
    allowAllModels: proxyKey.allowAllModels,
    allowedChannelNames: parseStringArray(proxyKey.allowedChannelIds)
      .map((channelId) => channelNameById.get(channelId))
      .filter((name): name is string => Boolean(name)),
    allowedModels: uniqueModelRefs(
      parseStringArray(proxyKey.allowedModelIds)
        .map((modelId) => modelRefById.get(modelId))
        .filter((ref): ref is BackupModelRef => Boolean(ref))
    ),
    unifiedMode: proxyKey.unifiedMode,
    allowedUnifiedModels: parseStringArray(proxyKey.allowedUnifiedModels),
    temporaryStopValue: proxyKey.temporaryStopValue,
    temporaryStopUnit: proxyKey.temporaryStopUnit,
    unifiedRouteStrategy: proxyKey.unifiedRouteStrategy,
    builtin: proxyKey.id === BUILTIN_PROXY_KEY_DB_ID,
  }));

  return {
    version: SITE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    channels: exportedChannels,
    schedulerConfig: exportedSchedulerConfig,
    proxyKeys: exportedProxyKeys,
    modelKeywords: modelKeywords.map((item) => ({
      keyword: item.keyword,
      enabled: item.enabled,
    })),
  };
}

export async function parseSiteBackupData(rawData: unknown): Promise<SiteBackupData> {
  const payload =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as JsonRecord)
      : { channels: rawData };

  const normalizedChannels = normalizeBackupChannels(payload.channels);
  const channelNameById = new Map<string, string>();
  const modelRefById = new Map<string, BackupModelRef>();

  if (normalizedChannels.length > 0) {
    const existingChannels = await prisma.channel.findMany({
      where: {
        OR: normalizedChannels.map((channel) => ({
          name: channel.name,
        })),
      },
      select: {
        id: true,
        name: true,
        channelKeys: {
          select: {
            id: true,
          },
          orderBy: [
            { createdAt: "asc" },
            { id: "asc" },
          ],
        },
        models: {
          select: {
            id: true,
            modelName: true,
            channelKeyId: true,
          },
        },
      },
    });

    for (const channel of existingChannels) {
      channelNameById.set(channel.id, channel.name);
      const keyIndexById = new Map(channel.channelKeys.map((key, index) => [key.id, index] as const));
      for (const model of channel.models) {
        modelRefById.set(
          model.id,
          buildChannelModelRef(
            channel.name,
            model.modelName,
            model.channelKeyId ? keyIndexById.get(model.channelKeyId) ?? null : null
          )
        );
      }
    }
  }

  return {
    version: parseNullableString(payload.version) || SITE_BACKUP_VERSION,
    exportedAt: parseNullableString(payload.exportedAt) || new Date().toISOString(),
    channels: normalizedChannels,
    schedulerConfig: normalizeLegacySchedulerConfig(payload.schedulerConfig, channelNameById, modelRefById),
    proxyKeys: normalizeLegacyProxyKeys(payload.proxyKeys, channelNameById, modelRefById),
    modelKeywords: normalizeKeywords(payload.modelKeywords),
  };
}

export async function importSiteBackupData(
  backupData: SiteBackupData,
  mode: "merge" | "replace"
): Promise<ImportSiteBackupResult> {
  const importedChannels: { id: string; name: string }[] = [];
  let imported = 0;
  let updated = 0;
  const skipped = 0;
  let duplicates = 0;

  await prisma.$transaction(async (tx) => {
    if (mode === "replace") {
      await tx.channel.deleteMany({});
      await tx.schedulerConfig.deleteMany({});
      await tx.proxyKey.deleteMany({});
      await tx.modelKeyword.deleteMany({});
    }

    const existingChannels = mode === "merge"
      ? await tx.channel.findMany({
          select: {
            id: true,
            name: true,
            baseUrl: true,
            apiKey: true,
          },
        })
      : [];

    const existingByName = new Map<string, (typeof existingChannels)[number]>(
      existingChannels.map((channel) => [channel.name, channel] as const)
    );
    const existingByKey = new Map<string, (typeof existingChannels)[number]>(
      existingChannels.map((channel) => [
        `${normalizeBaseUrl(channel.baseUrl)}\u0000${channel.apiKey}`,
        channel,
      ] as const)
    );
    const seenImportKeys = new Set<string>();
    const restoredModelIdByRefKey = new Map<string, string>();
    const restoredChannelIdByName = new Map<string, string>();

    for (const channel of backupData.channels) {
      const importKey = `${channel.baseUrl}\u0000${channel.apiKey}`;
      if (seenImportKeys.has(importKey)) {
        duplicates += 1;
        continue;
      }
      seenImportKeys.add(importKey);

      const existing = mode === "merge"
        ? existingByName.get(channel.name) ?? existingByKey.get(importKey)
        : undefined;

      const restoredChannel = await restoreChannel(tx, channel, existing?.id);
      if (channel.models.length === 0) {
        importedChannels.push({
          id: restoredChannel.channelId,
          name: restoredChannel.channelName,
        });
      }
      restoredChannelIdByName.set(restoredChannel.channelName, restoredChannel.channelId);
      for (const [refKey, modelId] of restoredChannel.modelIdByRefKey) {
        restoredModelIdByRefKey.set(refKey, modelId);
      }

      if (existing) {
        updated += 1;
      } else {
        imported += 1;
      }
    }

    if (backupData.schedulerConfig) {
      const selectedChannelIds = backupData.schedulerConfig.selectedChannelNames
        .map((channelName) => restoredChannelIdByName.get(channelName))
        .filter((channelId): channelId is string => Boolean(channelId));

      const selectedModelIds = backupData.schedulerConfig.selectedModels.reduce<Record<string, string[]>>(
        (accumulator, ref) => {
          const channelId = restoredChannelIdByName.get(ref.channelName);
          const modelId = restoredModelIdByRefKey.get(buildModelRefKey(ref));
          if (!channelId || !modelId) {
            return accumulator;
          }
          if (!accumulator[channelId]) {
            accumulator[channelId] = [];
          }
          if (!accumulator[channelId].includes(modelId)) {
            accumulator[channelId].push(modelId);
          }
          return accumulator;
        },
        {}
      );

      await tx.schedulerConfig.upsert({
        where: { id: "default" },
        update: {
          enabled: backupData.schedulerConfig.enabled,
          cronSchedule: backupData.schedulerConfig.cronSchedule,
          timezone: backupData.schedulerConfig.timezone,
          channelConcurrency: backupData.schedulerConfig.channelConcurrency,
          maxGlobalConcurrency: backupData.schedulerConfig.maxGlobalConcurrency,
          minDelayMs: backupData.schedulerConfig.minDelayMs,
          maxDelayMs: backupData.schedulerConfig.maxDelayMs,
          detectAllChannels: backupData.schedulerConfig.detectAllChannels,
          selectedChannelIds:
            selectedChannelIds.length > 0 ? selectedChannelIds : Prisma.JsonNull,
          selectedModelIds:
            Object.keys(selectedModelIds).length > 0 ? selectedModelIds : Prisma.JsonNull,
        },
        create: {
          id: "default",
          enabled: backupData.schedulerConfig.enabled,
          cronSchedule: backupData.schedulerConfig.cronSchedule,
          timezone: backupData.schedulerConfig.timezone,
          channelConcurrency: backupData.schedulerConfig.channelConcurrency,
          maxGlobalConcurrency: backupData.schedulerConfig.maxGlobalConcurrency,
          minDelayMs: backupData.schedulerConfig.minDelayMs,
          maxDelayMs: backupData.schedulerConfig.maxDelayMs,
          detectAllChannels: backupData.schedulerConfig.detectAllChannels,
          selectedChannelIds:
            selectedChannelIds.length > 0 ? selectedChannelIds : Prisma.JsonNull,
          selectedModelIds:
            Object.keys(selectedModelIds).length > 0 ? selectedModelIds : Prisma.JsonNull,
        },
      });
    }

    if (mode === "replace") {
      if (backupData.modelKeywords.length > 0) {
        await tx.modelKeyword.createMany({
          data: backupData.modelKeywords.map((keyword) => ({
            keyword: keyword.keyword,
            enabled: keyword.enabled,
          })),
          skipDuplicates: true,
        });
      }
    } else {
      for (const keyword of backupData.modelKeywords) {
        await tx.modelKeyword.upsert({
          where: { keyword: keyword.keyword },
          update: {
            enabled: keyword.enabled,
          },
          create: {
            keyword: keyword.keyword,
            enabled: keyword.enabled,
          },
        });
      }
    }

    for (const proxyKey of backupData.proxyKeys) {
      const allowedChannelIds = proxyKey.allowedChannelNames
        .map((channelName) => restoredChannelIdByName.get(channelName))
        .filter((channelId): channelId is string => Boolean(channelId));
      const allowedModelIds = proxyKey.allowedModels
        .map((ref) => restoredModelIdByRefKey.get(buildModelRefKey(ref)))
        .filter((modelId): modelId is string => Boolean(modelId));

      const data = {
        name: proxyKey.name,
        key: proxyKey.key,
        enabled: proxyKey.enabled,
        allowAllModels: proxyKey.allowAllModels,
        allowedChannelIds: proxyKey.allowAllModels
          ? Prisma.JsonNull
          : toJsonNullIfEmptyStringArray(allowedChannelIds),
        allowedModelIds: proxyKey.allowAllModels
          ? Prisma.JsonNull
          : toJsonNullIfEmptyStringArray(allowedModelIds),
        unifiedMode: proxyKey.unifiedMode,
        allowedUnifiedModels:
          proxyKey.allowedUnifiedModels.length > 0
            ? proxyKey.allowedUnifiedModels
            : Prisma.JsonNull,
        temporaryStopValue: proxyKey.temporaryStopValue,
        temporaryStopUnit: proxyKey.temporaryStopUnit,
        unifiedRouteStrategy: proxyKey.unifiedRouteStrategy,
      };

      if (proxyKey.builtin) {
        await tx.proxyKey.upsert({
          where: { id: BUILTIN_PROXY_KEY_DB_ID },
          update: data,
          create: {
            id: BUILTIN_PROXY_KEY_DB_ID,
            ...data,
          },
        });
        continue;
      }

      const existingProxyKey = mode === "merge"
        ? await tx.proxyKey.findFirst({
            where: {
              OR: [
                { key: proxyKey.key },
                { name: proxyKey.name },
              ],
            },
            select: { id: true },
          })
        : null;

      if (existingProxyKey) {
        await tx.proxyKey.update({
          where: { id: existingProxyKey.id },
          data,
        });
      } else {
        await tx.proxyKey.create({
          data,
        });
      }
    }
  });

  reloadWorkerConfig();

  return {
    imported,
    updated,
    skipped,
    duplicates,
    total: backupData.channels.length,
    importedChannels,
  };
}

export function mergeSiteBackupData(
  primary: SiteBackupData,
  secondary: SiteBackupData
): SiteBackupData {
  const mergedChannels = new Map<string, BackupChannelData>();
  for (const channel of secondary.channels) {
    mergedChannels.set(`${channel.name}\u0000${channel.baseUrl}\u0000${channel.apiKey}`, channel);
  }
  for (const channel of primary.channels) {
    const existingEntry = Array.from(mergedChannels.entries()).find(([, value]) =>
      value.name === channel.name ||
      (value.baseUrl === channel.baseUrl && value.apiKey === channel.apiKey)
    );
    if (existingEntry) {
      mergedChannels.delete(existingEntry[0]);
    }
    mergedChannels.set(`${channel.name}\u0000${channel.baseUrl}\u0000${channel.apiKey}`, channel);
  }

  const mergedKeywords = new Map<string, BackupKeywordData>();
  for (const keyword of secondary.modelKeywords) {
    mergedKeywords.set(keyword.keyword, keyword);
  }
  for (const keyword of primary.modelKeywords) {
    mergedKeywords.set(keyword.keyword, keyword);
  }

  const mergedProxyKeys = new Map<string, BackupProxyKeyData>();
  for (const proxyKey of secondary.proxyKeys) {
    mergedProxyKeys.set(proxyKey.builtin ? "__builtin__" : proxyKey.key, proxyKey);
  }
  for (const proxyKey of primary.proxyKeys) {
    mergedProxyKeys.set(proxyKey.builtin ? "__builtin__" : proxyKey.key, proxyKey);
  }

  return {
    version: SITE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    channels: Array.from(mergedChannels.values()).sort((left, right) => left.sortOrder - right.sortOrder),
    schedulerConfig: primary.schedulerConfig ?? secondary.schedulerConfig,
    proxyKeys: Array.from(mergedProxyKeys.values()),
    modelKeywords: Array.from(mergedKeywords.values()),
  };
}
