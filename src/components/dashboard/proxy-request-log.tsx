"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Search, Trash2, X } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface ProxyRequestLogItem {
  id: string;
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

function getUpstreamPath(value: string | null): string {
  switch (value) {
    case "CHAT":
      return "/v1/chat/completions";
    case "CLAUDE":
      return "/v1/messages";
    case "GEMINI":
      return "/v1beta/models/...";
    case "CODEX":
      return "/v1/responses";
    case "IMAGE":
      return "/v1/images/generations";
    default:
      return "-";
  }
}

function getStatusLabel(value: string): string {
  return STATUS_OPTIONS.find((item) => item.value === value)?.label || "全部结果";
}

function getPathBadges(requestPath: string, endpointType: string | null): string[] {
  const upstreamPath = getUpstreamPath(endpointType);

  if (upstreamPath === "-" || requestPath === upstreamPath) {
    return ["同一路径"];
  }

  return ["用户请求", "上游请求"];
}

function DetailItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-sm break-all", mono && "font-mono")}>{value || "-"}</div>
    </div>
  );
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
          <div className="hidden grid-cols-[180px_100px_minmax(0,1.3fr)_minmax(0,1fr)_90px_80px_48px] gap-3 border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground lg:grid dark:bg-muted/10 md:px-5">
            <span>时间</span>
            <span>类型</span>
            <span>模型 / 路径</span>
            <span>渠道 / Key</span>
            <span>结果</span>
            <span>耗时</span>
            <span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-border">
            {data.logs.map((log) => {
              const isExpanded = expandedId === log.id;
              const pathBadges = getPathBadges(log.requestPath, log.endpointType);
              const upstreamPath = getUpstreamPath(log.endpointType);
              const hasDifferentUpstreamPath = upstreamPath !== "-" && log.requestPath !== upstreamPath;

              return (
                <div key={log.id} className="overflow-hidden">
                  <div className="grid w-full gap-3 px-4 py-3 transition-colors hover:bg-muted/30 dark:hover:bg-muted/10 md:px-5 lg:grid-cols-[minmax(0,1fr)_48px] lg:items-center">
                    <button
                      type="button"
                      onClick={() => setExpandedId((prev) => prev === log.id ? null : log.id)}
                      className="grid w-full gap-3 text-left lg:grid-cols-[180px_100px_minmax(0,1.3fr)_minmax(0,1fr)_90px_80px_40px] lg:items-center"
                    >
                    <div className="text-xs text-muted-foreground md:text-sm">
                      {formatTime(log.createdAt)}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-border bg-background px-2 py-1 font-medium dark:bg-muted/20">
                        {log.requestMethod}
                      </span>
                      <span className="rounded-full border border-border bg-muted/40 px-2 py-1 font-medium dark:bg-muted/20">
                        {formatEndpointLabel(log.endpointType)}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm font-medium text-foreground" title={log.requestedModel || "-"}>
                        {log.requestedModel || "-"}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {pathBadges.map((badge) => (
                          <span
                            key={badge}
                            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground dark:bg-muted/20"
                          >
                            {badge}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={log.requestPath}>
                        {log.requestPath}
                      </div>
                    </div>

                    <div className="min-w-0 text-sm">
                      <div className="truncate text-foreground" title={log.channelName || "-"}>
                        {log.channelName || "-"}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={log.proxyKeyName || "-"}>
                        {log.proxyKeyName || "-"}
                      </div>
                    </div>

                    <div className={cn(
                      "text-sm font-medium",
                      log.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"
                    )}>
                      {log.success ? "成功" : "失败"}
                    </div>

                    <div className="text-sm text-muted-foreground lg:text-left">
                      {log.latency ? `${log.latency}ms` : "-"}
                    </div>

                    <div className="flex justify-end text-muted-foreground lg:justify-center">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDeleteLogs("single", log.id)}
                      disabled={deletingTarget !== null}
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50 disabled:text-muted-foreground"
                      title="删除这条日志"
                    >
                      {deletingTarget === log.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-border bg-muted/20 px-4 py-3 dark:bg-muted/10 md:px-5">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <DetailItem label="请求模型" value={log.requestedModel || "-"} mono />
                      <DetailItem label="实际模型" value={log.actualModelName || "-"} mono />
                      <DetailItem
                        label={hasDifferentUpstreamPath ? "请求路径" : "路径"}
                        value={log.requestPath}
                        mono
                      />
                      <DetailItem label="上游端点" value={formatEndpointLabel(log.endpointType)} />
                      <DetailItem
                        label={hasDifferentUpstreamPath ? "上游路径" : "实际路径"}
                        value={upstreamPath}
                        mono
                      />
                      <DetailItem label="请求方法" value={log.requestMethod} />
                      <DetailItem label="请求时间" value={formatTime(log.createdAt)} />
                      <DetailItem label="渠道名" value={log.channelName || "-"} />
                      <DetailItem label="代理 Key" value={log.proxyKeyName || "-"} />
                      <DetailItem label="传输方式" value={log.isStream ? "流式" : "普通"} />
                      <DetailItem label="状态码" value={String(log.statusCode ?? "-")} />
                      <DetailItem label="耗时" value={log.latency ? `${log.latency}ms` : "-"} />
                      <DetailItem label="执行结果" value={log.success ? "成功" : "失败"} />
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {pathBadges.map((badge) => (
                        <span
                          key={`detail-${badge}`}
                          className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground dark:bg-muted/20"
                        >
                          {badge}
                        </span>
                      ))}
                    </div>

                    {hasDifferentUpstreamPath && (
                      <div className="mt-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                        用户路径：{log.requestPath} · 上游路径：{upstreamPath}
                      </div>
                    )}

                      {log.errorMsg && (
                        <div className="mt-2.5 space-y-1.5">
                          <div className="text-xs text-muted-foreground">错误详情</div>
                          <pre className="rounded-xl border border-red-300/50 bg-red-500/5 px-3 py-2 text-xs text-red-600 whitespace-pre-wrap break-all dark:border-red-500/30 dark:text-red-400">
                            {log.errorMsg}
                          </pre>
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
