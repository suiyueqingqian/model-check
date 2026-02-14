// Scheduler configuration modal
// Allows setting cron schedule, concurrency, delay, and channel/model selection

"use client";

import { useState, useEffect, FormEvent } from "react";
import { X, Loader2, Clock } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface SchedulerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
}

type IntervalUnit = "minute" | "hour" | "day";

const INTERVAL_PREFIX = "interval:";
const MAX_DAILY_RUNS = 6;
const DEFAULT_DAY_TIMES = ["08:00", "12:00", "16:00", "20:00", "22:00", "23:00"];
const MINUTES_PER_DAY = 24 * 60;

const INTERVAL_UNIT_OPTIONS: Array<{ label: string; value: IntervalUnit }> = [
  { label: "分钟", value: "minute" },
  { label: "小时", value: "hour" },
  { label: "天", value: "day" },
];

const INTERVAL_RANGES: Record<IntervalUnit, { min: number; max: number; unitLabel: string }> = {
  minute: { min: 1, max: 60, unitLabel: "分钟" },
  hour: { min: 1, max: 24, unitLabel: "小时" },
  day: { min: 1, max: 7, unitLabel: "天" },
};

interface ParsedIntervalSchedule {
  unit: IntervalUnit;
  value: number;
  startAtLocal: string;
  dayRunCount: number;
  dayTimes: string[];
  isLegacyCron: boolean;
}

function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getDefaultStartAtLocal(): string {
  return formatDateTimeLocal(new Date());
}

function normalizeDayTimes(times: string[]): string[] {
  const normalized = [...DEFAULT_DAY_TIMES];
  times.slice(0, MAX_DAILY_RUNS).forEach((time, index) => {
    normalized[index] = time;
  });
  return normalized;
}

function formatMinutesToTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minute = String(normalized % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function buildAverageDayTimes(startAtLocal: string, dayRunCount: number): string[] {
  const parsed = new Date(startAtLocal);
  const startMinutes = Number.isNaN(parsed.getTime())
    ? 0
    : parsed.getHours() * 60 + parsed.getMinutes();
  const count = Math.max(1, Math.min(MAX_DAILY_RUNS, dayRunCount));
  const intervalMinutes = Math.floor(MINUTES_PER_DAY / count);
  const generated = Array.from({ length: count }, (_, index) =>
    formatMinutesToTime(startMinutes + index * intervalMinutes)
  ).sort();

  return normalizeDayTimes(generated);
}

function areDayTimesSame(left: string[], right: string[], count: number): boolean {
  const selectedCount = Math.max(1, Math.min(MAX_DAILY_RUNS, count));
  return left.slice(0, selectedCount).join(",") === right.slice(0, selectedCount).join(",");
}

function isValidTimeString(time: string): boolean {
  return /^\d{2}:\d{2}$/.test(time);
}

function isStrictlyIncreasingTimes(times: string[]): boolean {
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] <= times[i - 1]) return false;
  }
  return true;
}

function getMetaValue(metaSegments: string[], key: string): string | null {
  const prefix = `${key}=`;
  const segment = metaSegments.find((item) => item.startsWith(prefix));
  if (!segment) return null;
  return segment.slice(prefix.length);
}

function getDefaultIntervalSchedule(isLegacyCron: boolean): ParsedIntervalSchedule {
  return {
    unit: "hour",
    value: 1,
    startAtLocal: getDefaultStartAtLocal(),
    dayRunCount: 4,
    dayTimes: [...DEFAULT_DAY_TIMES],
    isLegacyCron,
  };
}

function parseLegacyCronToInterval(cronSchedule: string): ParsedIntervalSchedule | null {
  const trimmed = cronSchedule.trim();
  const defaults = getDefaultIntervalSchedule(true);

  const minuteMatch = trimmed.match(/^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
  if (minuteMatch) {
    const value = Number(minuteMatch[1]);
    if (value >= INTERVAL_RANGES.minute.min && value <= INTERVAL_RANGES.minute.max) {
      return { ...defaults, unit: "minute", value };
    }
  }

  if (trimmed === "0 * * * *") {
    return { ...defaults, unit: "hour", value: 1 };
  }

  const hourMatch = trimmed.match(/^0\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (hourMatch) {
    const value = Number(hourMatch[1]);
    if (value >= INTERVAL_RANGES.hour.min && value <= INTERVAL_RANGES.hour.max) {
      return { ...defaults, unit: "hour", value };
    }
  }

  const dayMatch = trimmed.match(/^0\s+0\s+\*\/(\d{1,2})\s+\*\s+\*$/);
  if (dayMatch) {
    const value = Number(dayMatch[1]);
    if (value >= INTERVAL_RANGES.day.min && value <= INTERVAL_RANGES.day.max) {
      return { ...defaults, unit: "day", value, dayRunCount: 1 };
    }
  }

  return null;
}

function parseStoredScheduleToInterval(cronSchedule: string): ParsedIntervalSchedule {
  const defaults = getDefaultIntervalSchedule(true);
  const trimmed = cronSchedule.trim();
  if (!trimmed.startsWith(INTERVAL_PREFIX)) {
    return parseLegacyCronToInterval(trimmed) ?? defaults;
  }

  const [prefix, unitPart, valuePart, ...anchorParts] = trimmed.split(":");
  if (prefix !== "interval") {
    return defaults;
  }

  const unit = unitPart as IntervalUnit;
  if (!(unit in INTERVAL_RANGES)) {
    return defaults;
  }

  const value = Number(valuePart);
  const range = INTERVAL_RANGES[unit];
  if (Number.isNaN(value) || value < range.min || value > range.max) {
    return defaults;
  }

  const anchorWithMeta = anchorParts.join(":");
  const [anchorIso, ...metaSegments] = anchorWithMeta.split("|");
  const parsedAnchor = new Date(anchorIso);
  const startAtLocal = Number.isNaN(parsedAnchor.getTime())
    ? defaults.startAtLocal
    : formatDateTimeLocal(parsedAnchor);

  let dayTimes = [...DEFAULT_DAY_TIMES];
  let dayRunCount = 1;

  if (unit === "day") {
    const timesRaw = getMetaValue(metaSegments, "times");
    if (timesRaw) {
      const times = timesRaw.split(",").map((item) => item.trim()).filter(Boolean);
      if (
        times.length > 0 &&
        times.length <= MAX_DAILY_RUNS &&
        times.every(isValidTimeString) &&
        isStrictlyIncreasingTimes(times)
      ) {
        dayRunCount = times.length;
        dayTimes = normalizeDayTimes(times);
      }
    } else {
      const timeFromStart = startAtLocal.slice(11, 16);
      if (isValidTimeString(timeFromStart)) {
        dayTimes = normalizeDayTimes([timeFromStart]);
      }
    }
  }

  return {
    unit,
    value,
    startAtLocal,
    dayRunCount,
    dayTimes,
    isLegacyCron: false,
  };
}

function buildIntervalSchedule(
  unit: IntervalUnit,
  value: number,
  startAtLocal: string,
  dayTimes: string[]
): string {
  const anchor = new Date(startAtLocal);
  const anchorIso = Number.isNaN(anchor.getTime()) ? new Date().toISOString() : anchor.toISOString();
  const offsetMinutes = Number.isNaN(anchor.getTime()) ? new Date().getTimezoneOffset() : anchor.getTimezoneOffset();

  let schedule = `${INTERVAL_PREFIX}${unit}:${value}:${anchorIso}|offset=${offsetMinutes}`;
  if (unit === "day") {
    schedule += `|times=${dayTimes.join(",")}`;
  }
  return schedule;
}

function validateIntervalValue(unit: IntervalUnit, value: number): string | null {
  const range = INTERVAL_RANGES[unit];
  if (Number.isNaN(value) || value < range.min || value > range.max) {
    return `${range.unitLabel}范围是 ${range.min}-${range.max}`;
  }
  return null;
}

function validateStartAtLocal(startAtLocal: string): string | null {
  if (!startAtLocal) return "请设置起始时间";
  const parsed = new Date(startAtLocal);
  if (Number.isNaN(parsed.getTime())) return "起始时间格式不正确";
  return null;
}

function validateDayTimes(dayRunCount: number, dayTimes: string[]): string | null {
  const selected = dayTimes.slice(0, dayRunCount);
  if (selected.some((time) => !isValidTimeString(time))) {
    return "执行时间格式不正确";
  }
  if (!isStrictlyIncreasingTimes(selected)) {
    return "执行时间必须按顺序递增，且不能重复";
  }
  return null;
}

export function SchedulerModal({ isOpen, onClose, onSave }: SchedulerModalProps) {
  const { token } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nextRun, setNextRun] = useState<string | null>(null);

  // Form state
  const [enabled, setEnabled] = useState(true);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("hour");
  const [intervalValue, setIntervalValue] = useState(1);
  const [startAtLocal, setStartAtLocal] = useState(getDefaultStartAtLocal());
  const [dayRunCount, setDayRunCount] = useState(4);
  const [dayTimes, setDayTimes] = useState<string[]>([...DEFAULT_DAY_TIMES]);
  const [useCustomDayTimes, setUseCustomDayTimes] = useState(false);
  const [channelConcurrency, setChannelConcurrency] = useState(5);
  const [maxGlobalConcurrency, setMaxGlobalConcurrency] = useState(30);
  const [minDelayMs, setMinDelayMs] = useState(3000);
  const [maxDelayMs, setMaxDelayMs] = useState(5000);

  // Load config on open
  useEffect(() => {
    if (!isOpen || !token) return;

    const controller = new AbortController();

    const loadConfig = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/scheduler/config", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (!response.ok) throw new Error("Failed to load config");

        const data = await response.json();

        if (controller.signal.aborted) return;

        setNextRun(data.nextRun);

        // Initialize form state
        setEnabled(data.config.enabled);
        const parsedSchedule = parseStoredScheduleToInterval(data.config.cronSchedule);
        const averageDayTimes = buildAverageDayTimes(parsedSchedule.startAtLocal, parsedSchedule.dayRunCount);
        const hasCustomDayTimes = parsedSchedule.unit === "day"
          && !areDayTimesSame(parsedSchedule.dayTimes, averageDayTimes, parsedSchedule.dayRunCount);
        setIntervalUnit(parsedSchedule.unit);
        setIntervalValue(parsedSchedule.value);
        setStartAtLocal(parsedSchedule.startAtLocal);
        setDayRunCount(parsedSchedule.dayRunCount);
        setUseCustomDayTimes(parsedSchedule.unit === "day" ? hasCustomDayTimes : false);
        setDayTimes(parsedSchedule.unit === "day" && !hasCustomDayTimes ? averageDayTimes : parsedSchedule.dayTimes);
        setChannelConcurrency(data.config.channelConcurrency);
        setMaxGlobalConcurrency(data.config.maxGlobalConcurrency);
        setMinDelayMs(data.config.minDelayMs);
        setMaxDelayMs(data.config.maxDelayMs);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          toast("加载配置失败", "error");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    loadConfig();
    return () => controller.abort();
  }, [isOpen, token, toast]);

  useEffect(() => {
    if (intervalUnit !== "day" || useCustomDayTimes) return;
    setDayTimes(buildAverageDayTimes(startAtLocal, dayRunCount));
  }, [intervalUnit, startAtLocal, dayRunCount, useCustomDayTimes]);

  // Handle save
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();

    const scheduleIntervalValue = intervalValue;
    const effectiveDayTimes = intervalUnit === "day"
      ? (useCustomDayTimes
        ? dayTimes.slice(0, dayRunCount)
        : buildAverageDayTimes(startAtLocal, dayRunCount).slice(0, dayRunCount))
      : dayTimes.slice(0, dayRunCount);

    const validationError = validateIntervalValue(intervalUnit, scheduleIntervalValue);
    if (validationError) {
      toast(validationError, "error");
      return;
    }

    const startAtError = validateStartAtLocal(startAtLocal);
    if (startAtError) {
      toast(startAtError, "error");
      return;
    }

    if (intervalUnit === "day") {
      const dayTimeError = validateDayTimes(dayRunCount, effectiveDayTimes);
      if (dayTimeError) {
        toast(dayTimeError, "error");
        return;
      }
    }

    setSaving(true);
    try {
      const cronSchedule = buildIntervalSchedule(
        intervalUnit,
        scheduleIntervalValue,
        startAtLocal,
        effectiveDayTimes
      );
      const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      const response = await fetch("/api/scheduler/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled,
          cronSchedule,
          timezone: localTimezone,
          channelConcurrency,
          maxGlobalConcurrency,
          minDelayMs,
          maxDelayMs,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "保存失败");
      }

      const data = await response.json();
      setNextRun(data.nextRun);
      toast("配置已保存", "success");
      onSave?.();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  // Format next run time
  const formatNextRun = (isoString: string | null): string => {
    if (!isoString) return "-";
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scheduler-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative bg-card rounded-lg shadow-xl border border-border w-[680px] max-w-[95vw] m-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 id="scheduler-modal-title" className="text-lg font-semibold flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-500" />
            定时检测设置
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-accent transition-colors"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="px-5 py-4 space-y-4">
            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">启用自动检测</label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={cn(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  enabled ? "bg-primary" : "bg-muted"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                    enabled ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>

            {/* Cron schedule */}
            <div>
              <label className="block text-sm font-medium mb-1.5">执行间隔</label>
              <div className="overflow-x-auto">
                <div className="flex items-center gap-2 flex-nowrap min-w-max">
                  <span className="px-2 text-sm text-foreground">每隔</span>
                  <input
                    type="number"
                    min={INTERVAL_RANGES[intervalUnit].min}
                    max={INTERVAL_RANGES[intervalUnit].max}
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(parseInt(e.target.value, 10) || 0)}
                    className="w-28 shrink-0 px-3 py-2 rounded-md border border-input bg-background text-sm"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => {
                      const nextUnit = e.target.value as IntervalUnit;
                      const range = INTERVAL_RANGES[nextUnit];
                      setIntervalUnit(nextUnit);
                      setIntervalValue((current) => Math.min(range.max, Math.max(range.min, current)));
                    }}
                    className="w-32 shrink-0 px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    {INTERVAL_UNIT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="px-2 shrink-0 text-sm text-muted-foreground">执行</span>
                  <div className="ml-2 inline-flex items-center gap-2 whitespace-nowrap shrink-0">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">起始时间</span>
                    <input
                      type="datetime-local"
                      value={startAtLocal}
                      onChange={(e) => setStartAtLocal(e.target.value)}
                      className="w-[200px] shrink-0 px-3 py-2 rounded-md border border-input bg-background text-sm"
                    />
                  </div>
                </div>
              </div>
              {intervalUnit === "day" && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label className="block text-xs text-muted-foreground mb-1">执行次数</label>
                      <select
                        value={dayRunCount}
                        onChange={(e) => setDayRunCount(Number(e.target.value))}
                        className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                      >
                        {Array.from({ length: MAX_DAILY_RUNS }, (_, index) => index + 1).map((count) => (
                          <option key={count} value={count}>
                            {count}次
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (useCustomDayTimes) {
                          setUseCustomDayTimes(false);
                          setDayTimes(buildAverageDayTimes(startAtLocal, dayRunCount));
                        } else {
                          setUseCustomDayTimes(true);
                        }
                      }}
                      className="px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors"
                    >
                      {useCustomDayTimes ? "恢复平均分配" : "自定义时间"}
                    </button>
                  </div>
                  {!useCustomDayTimes && (
                    <p className="text-xs text-muted-foreground">
                      默认按起始时间平均分配：{buildAverageDayTimes(startAtLocal, dayRunCount).slice(0, dayRunCount).join("、")}
                    </p>
                  )}
                  {useCustomDayTimes && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        {Array.from({ length: dayRunCount }, (_, index) => (
                          <div key={`day-time-${index}`}>
                            <label className="block text-xs text-muted-foreground mb-1">
                              第{index + 1}次（HH:mm）
                            </label>
                            <input
                              type="time"
                              value={dayTimes[index]}
                              min={index > 0 ? dayTimes[index - 1] : undefined}
                              onChange={(e) => {
                                const nextTimes = [...dayTimes];
                                nextTimes[index] = e.target.value;
                                setDayTimes(nextTimes);
                              }}
                              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                            />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        时间必须递增且不能重复，例如 08:00、12:00、16:00、20:00
                      </p>
                    </>
                  )}
                </div>
              )}
              {nextRun && enabled && (
                <p className="text-xs text-muted-foreground mt-1">
                  下次执行: {formatNextRun(nextRun)}
                </p>
              )}
            </div>

            {/* Concurrency and Delay in one row */}
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">全局并发</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={maxGlobalConcurrency}
                  onChange={(e) => setMaxGlobalConcurrency(parseInt(e.target.value) || 30)}
                  className="w-full px-2 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">渠道并发</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={channelConcurrency}
                  onChange={(e) => setChannelConcurrency(parseInt(e.target.value) || 5)}
                  className="w-full px-2 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">最小间隔</label>
                <input
                  type="number"
                  min="0"
                  max="60000"
                  step="500"
                  value={minDelayMs}
                  onChange={(e) => setMinDelayMs(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">最大间隔</label>
                <input
                  type="number"
                  min="0"
                  max="60000"
                  step="500"
                  value={maxDelayMs}
                  onChange={(e) => setMaxDelayMs(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-3 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                保存
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
