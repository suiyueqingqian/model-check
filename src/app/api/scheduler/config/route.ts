// Scheduler Config API - Get and update scheduler configuration

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import prisma from "@/lib/prisma";
import { reloadSchedulerConfig, getCronStatus } from "@/lib/scheduler";
import { reloadWorkerConfig } from "@/lib/queue/worker";

// Default configuration values (from environment variables)
const DEFAULT_CONFIG = {
  enabled: process.env.AUTO_DETECT_ENABLED !== "false",
  cronSchedule: process.env.CRON_SCHEDULE || "0 0,8,12,16,20 * * *",
  timezone: process.env.CRON_TIMEZONE || "Asia/Shanghai",
  channelConcurrency: parseInt(process.env.CHANNEL_CONCURRENCY || "5", 10),
  maxGlobalConcurrency: parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "30", 10),
  minDelayMs: parseInt(process.env.DETECTION_MIN_DELAY_MS || "3000", 10),
  maxDelayMs: parseInt(process.env.DETECTION_MAX_DELAY_MS || "5000", 10),
  detectAllChannels: process.env.AUTO_DETECT_ALL_CHANNELS !== "false",
};

const CRON_SCHEDULE_SEPARATOR = "||";
const INTERVAL_SCHEDULE_PREFIX = "interval:";

const INTERVAL_RANGES = {
  minute: { min: 1, max: 60 },
  hour: { min: 1, max: 24 },
  day: { min: 1, max: 7 },
} as const;
const MAX_DAILY_RUNS = 6;

type IntervalUnit = keyof typeof INTERVAL_RANGES;

function splitCronSchedules(cronSchedule: string): string[] {
  return cronSchedule
    .split(CRON_SCHEDULE_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isValidCronSchedule(cronSchedule: string): boolean {
  const schedules = splitCronSchedules(cronSchedule);
  return schedules.length > 0 && schedules.every((schedule) => schedule.split(/\s+/).length === 5);
}

function isValidIntervalSchedule(schedule: string): boolean {
  const trimmed = schedule.trim();
  if (!trimmed.startsWith(INTERVAL_SCHEDULE_PREFIX)) return false;

  const [prefix, unitPart, valuePart, ...anchorParts] = trimmed.split(":");
  if (prefix !== "interval") return false;

  if (!(unitPart in INTERVAL_RANGES)) return false;
  const unit = unitPart as IntervalUnit;

  const value = Number(valuePart);
  const range = INTERVAL_RANGES[unit];
  if (Number.isNaN(value) || value < range.min || value > range.max) return false;

  const anchorWithMeta = anchorParts.join(":");
  const [anchorIso, ...metaParts] = anchorWithMeta.split("|");
  if (Number.isNaN(Date.parse(anchorIso))) return false;

  const offsetPart = metaParts.find((item) => item.startsWith("offset="));
  if (offsetPart) {
    const offsetValue = Number(offsetPart.slice("offset=".length));
    if (Number.isNaN(offsetValue)) return false;
  }

  if (unit === "day") {
    const timesPart = metaParts.find((item) => item.startsWith("times="));
    if (!timesPart) return true;

    const times = timesPart
      .slice("times=".length)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (times.length === 0 || times.length > MAX_DAILY_RUNS) return false;
    if (times.some((time) => !/^\d{2}:\d{2}$/.test(time))) return false;

    for (let i = 1; i < times.length; i += 1) {
      if (times[i] <= times[i - 1]) return false;
    }
  }

  return true;
}

// GET /api/scheduler/config - Get scheduler configuration with channel list
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    // Get or create scheduler config
    let config = await prisma.schedulerConfig.findUnique({
      where: { id: "default" },
    });

    // If no config exists, create from defaults
    if (!config) {
      config = await prisma.schedulerConfig.create({
        data: {
          id: "default",
          ...DEFAULT_CONFIG,
        },
      });
    }

    // Get all enabled channels with their models
    const channels = await prisma.channel.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        models: {
          select: {
            id: true,
            modelName: true,
            lastStatus: true,
            detectedEndpoints: true,
          },
          orderBy: { modelName: "asc" },
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "desc" },
      ],
    });

    // Get cron status for next run time
    const cronStatus = getCronStatus();

    return NextResponse.json({
      config: {
        enabled: config.enabled,
        cronSchedule: config.cronSchedule,
        timezone: config.timezone,
        channelConcurrency: config.channelConcurrency,
        maxGlobalConcurrency: config.maxGlobalConcurrency,
        minDelayMs: config.minDelayMs,
        maxDelayMs: config.maxDelayMs,
        detectAllChannels: config.detectAllChannels,
        selectedChannelIds: config.selectedChannelIds,
        selectedModelIds: config.selectedModelIds,
        updatedAt: config.updatedAt,
      },
      channels,
      nextRun: cronStatus.detection.nextRun,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get scheduler config", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/scheduler/config - Update scheduler configuration
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const {
      enabled,
      cronSchedule,
      timezone,
      channelConcurrency,
      maxGlobalConcurrency,
      minDelayMs,
      maxDelayMs,
      detectAllChannels,
      selectedChannelIds,
      selectedModelIds,
    } = body;

    // Validate cron schedule format
    if (cronSchedule !== undefined) {
      const isValid = isValidIntervalSchedule(cronSchedule) || isValidCronSchedule(cronSchedule);
      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid schedule format", code: "INVALID_CRON" },
          { status: 400 }
        );
      }
    }

    // Validate delay values
    if (minDelayMs !== undefined && minDelayMs < 0) {
      return NextResponse.json(
        { error: "Delay values must be non-negative", code: "INVALID_DELAY" },
        { status: 400 }
      );
    }
    if (maxDelayMs !== undefined && maxDelayMs < 0) {
      return NextResponse.json(
        { error: "Delay values must be non-negative", code: "INVALID_DELAY" },
        { status: 400 }
      );
    }
    if (minDelayMs !== undefined || maxDelayMs !== undefined) {
      const existingConfig = await prisma.schedulerConfig.findUnique({
        where: { id: "default" },
        select: { minDelayMs: true, maxDelayMs: true },
      });
      const effectiveMin = minDelayMs ?? existingConfig?.minDelayMs ?? 0;
      const effectiveMax = maxDelayMs ?? existingConfig?.maxDelayMs ?? 0;
      if (effectiveMin > effectiveMax) {
        return NextResponse.json(
          { error: "Minimum delay cannot be greater than maximum delay", code: "INVALID_DELAY" },
          { status: 400 }
        );
      }
    }

    // Update or create config
    const config = await prisma.schedulerConfig.upsert({
      where: { id: "default" },
      update: {
        ...(enabled !== undefined && { enabled }),
        ...(cronSchedule !== undefined && { cronSchedule }),
        ...(timezone !== undefined && { timezone }),
        ...(channelConcurrency !== undefined && { channelConcurrency }),
        ...(maxGlobalConcurrency !== undefined && { maxGlobalConcurrency }),
        ...(minDelayMs !== undefined && { minDelayMs }),
        ...(maxDelayMs !== undefined && { maxDelayMs }),
        ...(detectAllChannels !== undefined && { detectAllChannels }),
        ...(selectedChannelIds !== undefined && { selectedChannelIds }),
        ...(selectedModelIds !== undefined && { selectedModelIds }),
      },
      create: {
        id: "default",
        ...DEFAULT_CONFIG,
        ...(enabled !== undefined && { enabled }),
        ...(cronSchedule !== undefined && { cronSchedule }),
        ...(timezone !== undefined && { timezone }),
        ...(channelConcurrency !== undefined && { channelConcurrency }),
        ...(maxGlobalConcurrency !== undefined && { maxGlobalConcurrency }),
        ...(minDelayMs !== undefined && { minDelayMs }),
        ...(maxDelayMs !== undefined && { maxDelayMs }),
        ...(detectAllChannels !== undefined && { detectAllChannels }),
        ...(selectedChannelIds !== undefined && { selectedChannelIds }),
        ...(selectedModelIds !== undefined && { selectedModelIds }),
      },
    });

    // Reload cron job with new configuration
    await reloadSchedulerConfig();

    // Reload worker runtime config for subsequent jobs
    reloadWorkerConfig();

    // Get updated cron status
    const cronStatus = getCronStatus();

    return NextResponse.json({
      success: true,
      config: {
        enabled: config.enabled,
        cronSchedule: config.cronSchedule,
        timezone: config.timezone,
        channelConcurrency: config.channelConcurrency,
        maxGlobalConcurrency: config.maxGlobalConcurrency,
        minDelayMs: config.minDelayMs,
        maxDelayMs: config.maxDelayMs,
        detectAllChannels: config.detectAllChannels,
        selectedChannelIds: config.selectedChannelIds,
        selectedModelIds: config.selectedModelIds,
        updatedAt: config.updatedAt,
      },
      nextRun: cronStatus.detection.nextRun,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update scheduler config", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}
