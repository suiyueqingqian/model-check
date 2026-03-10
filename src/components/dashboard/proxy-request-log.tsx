"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Search, Trash2, X } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface ProxyRequestLogItem {
  id: string;
  requestId: string | null;
  requestPath: string;
  requestMethod: string;
  endpointType: string | null;
  requestedModel: string | null;
  actualModelName: string | null;
  channelName: string | null;
  proxyKeyName: string | null;
  isStream: boolean;
  success: boolean;
  statusCode: number | null;
  latency: number | null;
  errorMsg: string | null;
  attempts: Array<{
    endpointType: string | null;
    upstreamPath: string | null;
    actualModelName: string | null;
    channelId: string | null;
    channelName: string | null;
    modelId: string | null;
    success: boolean;
    statusCode: number | null;
    latency: number | null;
    errorMsg: string | null;
  }> | null;
  createdAt: string;
}

interface ProxyRequestLogResponse {
  logs: ProxyRequestLogItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface ProxyRequestLogProps {
  refreshKey?: number;
  standalone?: boolean;
}

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 25, 50];
const AUTO_REFRESH_MS = 5000;

const ENDPOINT_OPTIONS = [
  { value: "all", label: "所有端点" },
  { value: "CHAT", label: "Chat" },
  { value: "CLAUDE", label: "Claude" },
  { value: "GEMINI", label: "Gemini" },
  { value: "CODEX", label: "Responses" },
  { value: "IMAGE", label: "Image" },
] as const;

const STATUS_OPTIONS = [
  { value: "all", label: "全部结果" },
  { value: "success", label: "成功" },
  { value: "fail", label: "失败" },
] as const;

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEndpointLabel(value: string | null): string {
  switch (value) {
    case "CHAT":
      return "Chat";
    case "CLAUDE":
      return "Claude";
    case "GEMINI":
      return "Gemini";
    case "CODEX":
      return "Responses";
    case "IMAGE":
      return "Image";
    default:
      return "-";
  }
}

function getStatusLabel(value: string): string {
  return STATUS_OPTIONS.find((item) => item.value === value)?.label || "全部结果";
}

function formatLatency(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}ms` : "-";
}

function getFinalResultLabel(log: ProxyRequestLogItem): string {
  const status = log.statusCode ?? "-";
  return `${log.success ? "成功" : "失败"} / ${status}`;
}

function getAttemptSummary(log: ProxyRequestLogItem): string {
  const attempts = Array.isArray(log.attempts) ? log.attempts : [];
  if (attempts.length === 0) {
    return log.channelName || "-";
  }

  const latestSuccess = [...attempts].reverse().find((attempt) => attempt.success);
  if (latestSuccess?.channelName) {
    return attempts.length > 1
      ? `${latestSuccess.channelName} · 共${attempts.length}次`
      : latestSuccess.channelName;
  }

  const latestAttempt = attempts[attempts.length - 1];
  if (latestAttempt?.channelName) {
    return attempts.length > 1
      ? `${latestAttempt.channelName} · 共${attempts.length}次`
      : latestAttempt.channelName;
  }

  return attempts.length > 0 ? `共${attempts.length}次尝试` : "-";
}

export function ProxyRequestLog({
  refreshKey = 0,
  standalone = false,
}: ProxyRequestLogProps) {
  const { isAuthenticated, token, authFetch } = useAuth();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [endpointType, setEndpointType] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [data, setData] = useState<ProxyRequestLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingTarget, setDeletingTarget] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // 搜索防抖
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const fetchLogs = useCallback(async (
    nextPage: number,
    nextPageSize: number,
    nextSearch: string,
    nextEndpointType: string,
    nextStatus: string,
    silent: boolean = false
  ) => {
    if (!token) {
      return;
    }

    if (!silent) {
      setLoading(true);
    }

    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(nextPageSize),
      });

      if (nextSearch) {
        params.set("search", nextSearch);
      }
      if (nextEndpointType !== "all") {
        params.set("endpointType", nextEndpointType);
      }
      if (nextStatus !== "all") {
        params.set("status", nextStatus);
      }

      const response = await authFetch(`/api/proxy-request-logs?${params}`);

      if (!response.ok) {
        throw new Error("获取代理请求日志失败");
      }

      const result = await response.json() as ProxyRequestLogResponse;
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取代理请求日志失败");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [token, authFetch]);

  const refreshCurrentPage = useCallback(async (nextPage?: number) => {
    const targetPage = nextPage ?? page;
    await fetchLogs(targetPage, pageSize, debouncedSearch, endpointType, status);
  }, [page, pageSize, debouncedSearch, endpointType, status, fetchLogs]);

  const handleDeleteLogs = useCallback(async (
    mode: "single" | "filtered" | "all",
    logId?: string
  ) => {
    const confirmMessage = mode === "single"
      ? "确定删除这条日志吗？"
      : mode === "filtered"
        ? "确定清空当前筛选结果吗？"
        : "确定清空全部日志吗？";

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setDeletingTarget(mode === "single" ? logId || "single" : mode);

    try {
      const response = await authFetch("/api/proxy-request-logs", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          mode === "single"
            ? { mode, id: logId }
            : mode === "filtered"
              ? { mode, search: debouncedSearch, endpointType, status }
              : { mode }
        ),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "删除日志失败");
      }

      const deletedCount = typeof result.deletedCount === "number" ? result.deletedCount : 0;
      toast(
        mode === "single"
          ? "日志已删除"
          : `已删除 ${deletedCount} 条日志`,
        "success"
      );

      if (mode === "single" && expandedId === logId) {
        setExpandedId(null);
      }

      const shouldFallbackPage =
        mode === "single" &&
        data &&
        data.logs.length === 1 &&
        page > 1;

      const nextPage = shouldFallbackPage ? page - 1 : 1;

      if (nextPage !== page) {
        setPage(nextPage);
      }

      await refreshCurrentPage(nextPage);
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除日志失败", "error");
    } finally {
      setDeletingTarget(null);
    }
  }, [authFetch, data, debouncedSearch, endpointType, expandedId, page, refreshCurrentPage, status, toast]);

  // 自动刷新（首次加载 + 定时刷新合并）
  useEffect(() => {
    if (!isAuthenticated || !token) return;

    // 首次立即加载
    fetchLogs(page, pageSize, debouncedSearch, endpointType, status);

    // 定时自动刷新
    const timer = setInterval(() => {
      void fetchLogs(page, pageSize, debouncedSearch, endpointType, status, true);
    }, AUTO_REFRESH_MS);

    return () => clearInterval(timer);
  }, [isAuthenticated, token, page, pageSize, debouncedSearch, endpointType, status, refreshKey, fetchLogs]);

  useEffect(() => {
    setExpandedId(null);
  }, [page, pageSize, debouncedSearch, endpointType, status]);

  if (!isAuthenticated) {
    return (
      <section className={cn("rounded-lg border bg-card p-6", standalone && "shadow-sm")}>
        <div className="text-center text-sm text-muted-foreground">
          请先在首页登录管理员账号，再查看代理请求日志。
        </div>
      </section>
    );
  }

  const totalPages = data?.pagination.totalPages ?? 1;
  const hasActiveFilters = debouncedSearch.trim().length > 0 || endpointType !== "all" || status !== "all";
  const activeFilterLabels: string[] = [];

  if (debouncedSearch.trim()) {
    activeFilterLabels.push(`搜索：${debouncedSearch.trim()}`);
  }
  if (endpointType !== "all") {
    activeFilterLabels.push(`端点：${formatEndpointLabel(endpointType)}`);
  }
  if (status !== "all") {
    activeFilterLabels.push(`结果：${getStatusLabel(status)}`);
  }

  const resetFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setEndpointType("all");
    setStatus("all");
    setPage(1);
  };

  return (
    <section className={cn(
      "space-y-3",
      standalone ? "w-full" : "rounded-2xl border border-border bg-card p-4"
    )}>
      <div className={cn(
        "rounded-2xl border border-border bg-card p-4 dark:bg-card",
        standalone && "shadow-sm"
      )}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1.6fr)_180px_160px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
                placeholder="搜索模型、渠道、路径、错误"
                className="h-10 w-full rounded-xl border border-input bg-background px-4 pl-10 pr-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </label>

            <select
              value={endpointType}
              onChange={(e) => {
                setPage(1);
                setEndpointType(e.target.value);
              }}
              className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
            >
              {ENDPOINT_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>

            <select
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value);
              }}
              className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {loading && (
              <div className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted-foreground dark:bg-muted/20">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                同步中
              </div>
            )}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                <X className="h-3.5 w-3.5" />
                清空筛选
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDeleteLogs("all")}
              disabled={deletingTarget !== null || !data || data.pagination.total === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-red-300/70 bg-background px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 disabled:text-muted-foreground dark:border-red-500/40 dark:bg-muted/20 dark:text-red-400"
            >
              {deletingTarget === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              清空全部
            </button>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="mt-3 flex flex-wrap gap-2">
            {activeFilterLabels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground dark:bg-muted/20"
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className={cn(
          "flex min-h-[240px] items-center justify-center rounded-2xl border border-border bg-card dark:bg-card",
          standalone && "shadow-sm"
        )}>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className={cn(
          "rounded-2xl border border-red-300/60 bg-red-500/5 p-4 text-sm text-red-600 dark:border-red-500/40 dark:text-red-400",
          standalone && "shadow-sm"
        )}>
          {error}
        </div>
      ) : data && data.logs.length > 0 ? (
        <div className={cn(
          "overflow-hidden rounded-2xl border border-border bg-card dark:bg-card",
          standalone && "shadow-sm"
        )}>
          <div className="hidden grid-cols-[180px_minmax(0,1.6fr)_minmax(0,1fr)_120px_80px_44px_44px] gap-3 border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground lg:grid dark:bg-muted/10 md:px-5">
            <span>时间</span>
            <span>模型 / 代理API请求路径</span>
            <span>渠道 / Key</span>
            <span>结果</span>
            <span>耗时</span>
            <span className="text-center">展开</span>
            <span className="text-center">删除</span>
          </div>
          <div className="divide-y divide-border">
            {data.logs.map((log) => {
              const isExpanded = expandedId === log.id;
              const attempts = Array.isArray(log.attempts) ? log.attempts : [];
              const attemptSummary = getAttemptSummary(log);

              return (
                <div key={log.id} className="overflow-hidden">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedId((prev) => prev === log.id ? null : log.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpandedId((prev) => prev === log.id ? null : log.id);
                      }
                    }}
                    className="grid w-full cursor-pointer gap-3 px-4 py-3 transition-colors hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:hover:bg-muted/10 md:px-5 lg:grid-cols-[180px_minmax(0,1.6fr)_minmax(0,1fr)_120px_80px_44px_44px] lg:items-center"
                  >
                    <div className="text-xs text-muted-foreground md:text-sm">
                      {formatTime(log.createdAt)}
                    </div>

                    <div className="min-w-0 text-left">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="truncate font-mono text-sm font-medium text-foreground" title={log.requestedModel || "-"}>
                          {log.requestedModel || "-"}
                        </div>
                        <span className="rounded-full border border-border bg-background px-1.5 py-px text-[10px] leading-4 text-muted-foreground dark:bg-muted/20">
                          {log.requestMethod}
                        </span>
                        <span className="rounded-full border border-border bg-muted/40 px-1.5 py-px text-[10px] leading-4 text-muted-foreground dark:bg-muted/20">
                          {formatEndpointLabel(log.endpointType)}
                        </span>
                        {log.isStream && (
                          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-px text-[10px] leading-4 text-muted-foreground dark:bg-muted/20">
                            流式
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={log.requestPath}>
                        {log.requestPath}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground" title={log.requestId || log.id}>
                        请求ID：{log.requestId || log.id}
                      </div>
                    </div>

                    <div className="min-w-0 text-sm">
                      <div className="truncate text-foreground" title={attemptSummary}>
                        {attemptSummary}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={log.proxyKeyName || "-"}>
                        {log.proxyKeyName || "-"}
                      </div>
                    </div>

                    <div className={cn(
                      "text-sm font-medium",
                      log.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"
                    )}>
                      {getFinalResultLabel(log)}
                    </div>

                    <div className="text-sm text-muted-foreground lg:text-left">
                      {formatLatency(log.latency)}
                    </div>

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedId((prev) => prev === log.id ? null : log.id);
                      }}
                      className="flex h-9 w-9 items-center justify-center justify-self-center rounded-xl text-muted-foreground transition-colors hover:bg-accent"
                      title={isExpanded ? "收起详情" : "展开详情"}
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteLogs("single", log.id);
                      }}
                      disabled={deletingTarget !== null}
                      className="flex h-9 w-9 items-center justify-center justify-self-center rounded-xl text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50 disabled:text-muted-foreground"
                      title="删除这条日志"
                    >
                      {deletingTarget === log.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border bg-muted/20 px-4 py-3 dark:bg-muted/10 md:px-5">
                      {attempts.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <div className="text-xs text-muted-foreground">上游尝试链路</div>
                          <div className="flex flex-wrap items-stretch gap-2">
                            {attempts.map((attempt, index) => (
                              <div key={`${log.id}-attempt-${index}`} className="flex items-stretch gap-2">
                                <div
                                  className={cn(
                                    "min-w-[220px] max-w-[280px] rounded-xl border px-3 py-2 dark:bg-muted/10",
                                    attempt.success
                                      ? "border-emerald-300/60 bg-emerald-500/5"
                                      : "border-red-300/60 bg-red-500/5"
                                  )}
                                >
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <span>第 {index + 1} 次</span>
                                    <span>{formatEndpointLabel(attempt.endpointType)}</span>
                                    <span>{attempt.statusCode ?? "-"}</span>
                                    <span>{formatLatency(attempt.latency)}</span>
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {(attempt.channelName || "-") + " / " + (attempt.actualModelName || "-")}
                                  </div>
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    上游请求端点
                                  </div>
                                  <div className="mt-1 font-mono text-xs text-muted-foreground break-all">
                                    {attempt.upstreamPath || "-"}
                                  </div>
                                  {attempt.errorMsg && (
                                    <div className="mt-2 line-clamp-3 text-xs text-red-600 dark:text-red-400">
                                      {attempt.errorMsg}
                                    </div>
                                  )}
                                </div>
                                {index < attempts.length - 1 && (
                                  <div className="flex items-center text-sm text-muted-foreground">
                                    →
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground md:px-5 lg:flex-row lg:items-center lg:justify-between">
            <span>
              第 {page} / {totalPages} 页，共 {data.pagination.total} 条
            </span>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <select
                value={String(pageSize)}
                onChange={(e) => {
                  setPage(1);
                  setPageSize(parseInt(e.target.value, 10));
                }}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              >
                {PAGE_SIZE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    每页 {value} 条
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1 || loading}
                className="rounded-xl border border-border px-3 py-2 text-foreground transition-colors hover:bg-accent disabled:opacity-50 disabled:text-muted-foreground"
              >
                上一页
              </button>
              <button
                type="button"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={page >= totalPages || loading}
                className="rounded-xl border border-border px-3 py-2 text-foreground transition-colors hover:bg-accent disabled:opacity-50 disabled:text-muted-foreground"
              >
                下一页
              </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={cn(
          "rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground dark:bg-card",
          standalone && "shadow-sm"
        )}>
          暂无代理请求日志
        </div>
      )}
    </section>
  );
}
