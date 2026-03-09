// Main dashboard component

"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Summary } from "@/components/dashboard/summary";
import { ChannelCard } from "@/components/dashboard/channel-card";
import { ChannelManager } from "@/components/dashboard/channel-manager";
import { ProxyKeyManager } from "@/components/dashboard/proxy-key-manager";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const EMPTY_SET = new Set<string>();

interface CheckLog {
  id: string;
  status: "SUCCESS" | "FAIL";
  latency: number | null;
  statusCode: number | null;
  endpointType: string;
  responseContent: string | null;
  errorMsg: string | null;
  createdAt: string;
}

interface Model {
  id: string;
  modelName: string;
  detectedEndpoints: string[] | null;
  lastStatus: boolean | null;
  lastLatency: number | null;
  lastCheckedAt: string | null;
  checkLogs: CheckLog[];
}

interface Channel {
  id: string;
  name: string;
  type: string;
  models: Model[];
}

interface Pagination {
  page: number;
  pageSize: number;
  totalPages: number;
  totalChannels: number;
}

interface DashboardData {
  authenticated: boolean;
  summary: {
    totalChannels: number;
    totalModels: number;
    healthyModels: number;
    healthRate: number;
  };
  pagination: Pagination;
  channels: Channel[];
}

// Filter types (exported for parent components)
export type EndpointFilter = "all" | "CHAT" | "CLAUDE" | "GEMINI" | "CODEX";
export type StatusFilter = "all" | "healthy" | "unhealthy" | "unknown";

interface DashboardProps {
  refreshKey?: number;
  // Filter props from header
  search?: string;
  endpointFilter?: EndpointFilter;
  statusFilter?: StatusFilter;
  // Testing state from parent
  testingModelIds?: Set<string>;
  onTestModels?: (modelIds: string[]) => void;
  onStopModels?: (modelIds: string[]) => void;
}

const PAGE_SIZE = 10;

export function Dashboard({
  refreshKey = 0,
  search = "",
  endpointFilter = "all",
  statusFilter = "all",
  testingModelIds = EMPTY_SET,
  onTestModels,
  onStopModels,
}: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const { isAuthenticated, token } = useAuth();
  const { toast, update } = useToast();

  const fetchData = useCallback(async (
    signal?: AbortSignal,
    page: number = 1,
    searchQuery: string = "",
    endpoint: EndpointFilter = "all",
    status: StatusFilter = "all"
  ) => {
    try {
      const token = localStorage.getItem("auth_token");
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });

      // Add filter parameters to API request
      if (searchQuery) {
        params.set("search", searchQuery);
      }
      if (endpoint !== "all") {
        params.set("endpointFilter", endpoint);
      }
      if (status !== "all") {
        params.set("statusFilter", status);
      }

      const response = await fetch(`/api/dashboard?${params}`, { headers, signal });
      if (!response.ok) {
        throw new Error("获取数据失败");
      }

      const result = await response.json();
      // Only update state if request wasn't aborted
      if (!signal?.aborted) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : "未知错误");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  // Delete channel handler
  const handleDeleteChannel = useCallback(async (channelId: string) => {
    if (!token) return;

    const toastId = toast("正在删除渠道...", "loading");
    try {
      const response = await fetch(`/api/channel?id=${channelId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error("删除渠道失败");
      }
      update(toastId, "渠道已删除", "success");
      fetchData(undefined, currentPage, search, endpointFilter, statusFilter);
    } catch (err) {
      update(toastId, err instanceof Error ? err.message : "删除失败", "error");
    }
  }, [token, toast, update, fetchData, currentPage, search, endpointFilter, statusFilter]);

  // Page change handler
  const handlePageChange = useCallback((newPage: number) => {
    setCurrentPage(newPage);
    setLoading(true);
    fetchData(undefined, newPage, search, endpointFilter, statusFilter);
  }, [fetchData, search, endpointFilter, statusFilter]);

  // Track previous values to detect changes
  const prevFiltersRef = useRef({ search, endpointFilter, statusFilter });
  const currentPageRef = useRef(currentPage);

  // Keep page ref in sync
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Fetch data on mount, refreshKey change, or filter changes
  useEffect(() => {
    const controller = new AbortController();
    const prevFilters = prevFiltersRef.current;
    const filtersChanged =
      prevFilters.search !== search ||
      prevFilters.endpointFilter !== endpointFilter ||
      prevFilters.statusFilter !== statusFilter;

    // Update previous filters
    prevFiltersRef.current = { search, endpointFilter, statusFilter };

    // Reset to page 1 only when filters change, not on refreshKey change
    let pageToFetch = currentPageRef.current;
    if (filtersChanged) {
      pageToFetch = 1;
      setCurrentPage(1);
    }

    fetchData(controller.signal, pageToFetch, search, endpointFilter, statusFilter);
    return () => controller.abort();
  }, [fetchData, refreshKey, search, endpointFilter, statusFilter]);

  // Sort models within channels - filtering is done server-side
  const sortedChannels = useMemo(() => {
    if (!data?.channels) return [];

    return data.channels.map((channel) => {
      // Sort models by status (healthy first, then unhealthy, then unknown)
      const sortedModels = [...channel.models].sort((a, b) => {
        const statusA = a.lastStatus === true ? 0 : a.lastStatus === false ? 1 : 2;
        const statusB = b.lastStatus === true ? 0 : b.lastStatus === false ? 1 : 2;
        return statusA - statusB;
      });

      return { ...channel, models: sortedModels };
    });
  }, [data?.channels]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-destructive">{error}</p>
        <button
          onClick={() => fetchData(undefined, currentPage, search, endpointFilter, statusFilter)}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          重试
        </button>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { pagination } = data;
  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="space-y-6">
      {/* Channel Manager (admin only) */}
      {isAuthenticated && <ChannelManager onUpdate={() => fetchData(undefined, currentPage, search, endpointFilter, statusFilter)} />}

      {/* Proxy Key Manager (admin only) */}
      {isAuthenticated && <ProxyKeyManager />}

      {/* Summary Stats */}
      <Summary data={data.summary} />

      {/* Channels List */}
      {sortedChannels.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {data.channels.length === 0 ? "暂无渠道配置" : "没有匹配的结果"}
        </div>
      ) : (
        <div className="grid gap-4">
          {sortedChannels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onDelete={handleDeleteChannel}
              testingModelIds={testingModelIds}
              onTestModels={onTestModels}
              onStopModels={onStopModels}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
            className={cn(
              "flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              currentPage <= 1 || loading
                ? "text-muted-foreground cursor-not-allowed"
                : "text-foreground hover:bg-accent"
            )}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </button>

          <div className="flex items-center gap-1">
            {/* Show page numbers */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((page) => {
                // Show first, last, current, and adjacent pages
                if (page === 1 || page === totalPages) return true;
                if (Math.abs(page - currentPage) <= 1) return true;
                return false;
              })
              .map((page, index, arr) => {
                // Add ellipsis if there's a gap
                const prevPage = arr[index - 1];
                const showEllipsis = prevPage && page - prevPage > 1;

                return (
                  <span key={page} className="flex items-center">
                    {showEllipsis && (
                      <span className="px-2 text-muted-foreground">...</span>
                    )}
                    <button
                      onClick={() => handlePageChange(page)}
                      disabled={loading}
                      className={cn(
                        "min-w-[36px] h-9 px-3 rounded-md text-sm font-medium transition-colors",
                        page === currentPage
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent text-foreground"
                      )}
                    >
                      {page}
                    </button>
                  </span>
                );
              })}
          </div>

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
            className={cn(
              "flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              currentPage >= totalPages || loading
                ? "text-muted-foreground cursor-not-allowed"
                : "text-foreground hover:bg-accent"
            )}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* Page info */}
          <span className="text-sm text-muted-foreground ml-4">
            第 {currentPage} / {totalPages} 页，共 {pagination.totalChannels} 个渠道
          </span>
        </div>
      )}
    </div>
  );
}
