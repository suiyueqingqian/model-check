// Main page component

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Header, EndpointFilter, StatusFilter } from "@/components/layout/header";
import { LoginModal } from "@/components/ui/login-modal";
import { Dashboard } from "@/components/dashboard";
import { useAuth } from "@/components/providers/auth-provider";
import { useSSE } from "@/hooks/use-sse";
import { logWarn } from "@/lib/utils/error";

// Polling interval for testing status (5 seconds)
const TESTING_STATUS_POLL_INTERVAL = 5000;
const TESTING_STATUS_RECONCILE_INTERVAL = 15000;
// Debounce delay for refreshKey updates (ms)
const REFRESH_DEBOUNCE_DELAY = 500;

export default function Home() {
  const [showLogin, setShowLogin] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filter state (shared between Header and Dashboard)
  const [search, setSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<EndpointFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Testing models state (track which models are currently being tested)
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(new Set());

  // Detection running state
  const [isDetectionRunning, setIsDetectionRunning] = useState(false);
  const { authFetch } = useAuth();

  // Track if polling should be active
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Debounce timer for refreshKey updates
  const refreshDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Ignore progress fetch after stop to prevent race condition
  const ignoreProgressFetchRef = useRef(false);
  // Ignore SSE events after stop
  const ignoreSSERef = useRef(false);
  // Timer for clearing ignore flags after stop
  const clearIgnoreFlagsTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Add models to testing set
  const addTestingModels = useCallback((modelIds: string[]) => {
    if (modelIds.length > 0) {
      setIsDetectionRunning(true);
    }
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      modelIds.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  // Remove model from testing set
  const removeTestingModel = useCallback((modelId: string) => {
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      next.delete(modelId);
      return next;
    });
  }, []);

  // Debounced refresh function for SSE events
  const debouncedRefresh = useCallback(() => {
    // Clear existing debounce timer
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }
    // Set new debounce timer
    refreshDebounceRef.current = setTimeout(() => {
      setRefreshKey((k) => k + 1);
      refreshDebounceRef.current = null;
    }, REFRESH_DEBOUNCE_DELAY);
  }, []);

  // SSE for real-time updates - must be before useEffects that depend on isConnected
  const { isConnected } = useSSE({
    onProgress: (event) => {
      // Ignore SSE events after stop
      if (ignoreSSERef.current) {
        return;
      }
      // Remove model from testing set only when ALL endpoints for this model are done
      if (event.type === "progress" && event.modelId && event.isModelComplete) {
        removeTestingModel(event.modelId);
      }
      // Trigger dashboard refresh with debounce to avoid rapid re-renders
      debouncedRefresh();
    },
  });

  // Fetch detection progress (used for initial load and polling fallback)
  const fetchProgress = useCallback(async () => {
    // Skip fetch if we just stopped detection (prevent race condition)
    if (ignoreProgressFetchRef.current) {
      return;
    }
    try {
      const response = await authFetch("/api/detect");
      if (!response.ok) {
        if (response.status === 401) {
          setTestingModelIds(new Set());
          setIsDetectionRunning(false);
        }
        return;
      }

      const data = await response.json();
      if (data.testingModelIds && Array.isArray(data.testingModelIds)) {
        setTestingModelIds(new Set(data.testingModelIds));
        setIsDetectionRunning(data.testingModelIds.length > 0);
      } else {
        setTestingModelIds(new Set());
        setIsDetectionRunning(false);
      }
    } catch (error) {
      logWarn("[Home] 获取检测进度失败", error);
    }
  }, [authFetch]);

  // Auto-update isDetectionRunning when testingModelIds becomes empty
  // This ensures the button state updates when all models finish testing via SSE
  useEffect(() => {
    if (isDetectionRunning && testingModelIds.size === 0) {
      // Double-check with server to confirm detection is complete
      void Promise.resolve().then(fetchProgress);
    }
  }, [testingModelIds.size, isDetectionRunning, fetchProgress]);

  // Remove multiple models from testing set (for stop action)
  const removeTestingModels = useCallback((modelIds: string[]) => {
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      modelIds.forEach((id) => next.delete(id));
      if (next.size === 0) {
        setIsDetectionRunning(false);
      }
      return next;
    });
    // Note: Removed fetchProgress() call here to prevent race condition
    // The SSE events will handle the final state update
  }, []);

  // Fetch initial detection progress on page load
  useEffect(() => {
    void Promise.resolve().then(fetchProgress);
  }, [fetchProgress]);

  // Poll for testing status. SSE 负责实时刷新，轮询负责兜底纠偏。
  useEffect(() => {
    // Clear existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (isDetectionRunning || testingModelIds.size > 0) {
      const intervalMs = isConnected
        ? TESTING_STATUS_RECONCILE_INTERVAL
        : TESTING_STATUS_POLL_INTERVAL;
      pollIntervalRef.current = setInterval(fetchProgress, intervalMs);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [isDetectionRunning, testingModelIds.size, isConnected, fetchProgress]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
    };
  }, []);

  // Handle detection start from header - immediately update UI
  const handleDetectionStart = useCallback(async (modelIds: string[] = []) => {
    // Cancel any pending clear-ignore-flags timer from previous stop
    if (clearIgnoreFlagsTimerRef.current) {
      clearTimeout(clearIgnoreFlagsTimerRef.current);
      clearIgnoreFlagsTimerRef.current = null;
    }
    // Clear ignore flags from previous stop
    ignoreProgressFetchRef.current = false;
    ignoreSSERef.current = false;

    setIsDetectionRunning(true);
    setTestingModelIds(new Set(modelIds));
    // Trigger dashboard refresh to show reset state
    setRefreshKey((k) => k + 1);
    // Fetch progress to get all model IDs that will be tested
    try {
      // Delay to let the backend reset model status and queue jobs
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchProgress();
    } catch (error) {
      logWarn("[Home] 启动后同步检测进度失败", error);
    }
  }, [fetchProgress]);

  // Handle detection stop from header
  const handleDetectionStop = useCallback(() => {
    setIsDetectionRunning(false);
    setTestingModelIds(new Set());
    // Set ignore flags to prevent race condition with pending responses
    ignoreProgressFetchRef.current = true;
    ignoreSSERef.current = true;
    // Cancel any pending clear-ignore-flags timer
    if (clearIgnoreFlagsTimerRef.current) {
      clearTimeout(clearIgnoreFlagsTimerRef.current);
    }
    // Clear ignore flags after 3 seconds to resume normal operation
    clearIgnoreFlagsTimerRef.current = setTimeout(() => {
      ignoreProgressFetchRef.current = false;
      ignoreSSERef.current = false;
      clearIgnoreFlagsTimerRef.current = null;
    }, 3000);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        onLoginClick={() => setShowLogin(true)}
        onGuestUploadSuccess={() => setRefreshKey((k) => k + 1)}
        isConnected={isConnected}
        isDetectionRunning={isDetectionRunning}
        search={search}
        onSearchChange={setSearch}
        endpointFilter={endpointFilter}
        onEndpointFilterChange={setEndpointFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onDetectionStart={handleDetectionStart}
        onDetectionStop={handleDetectionStop}
      />

      <main className="flex-1 container mx-auto px-4 py-6">
        <Dashboard
          refreshKey={refreshKey}
          search={search}
          endpointFilter={endpointFilter}
          statusFilter={statusFilter}
          testingModelIds={testingModelIds}
          onTestModels={addTestingModels}
          onStopModels={removeTestingModels}
        />
      </main>

      <footer className="border-t border-border py-4">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <a
            href="https://github.com/chxcodepro/model-check"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            模型检测
          </a>
          {" - API 渠道可用性检测系统"}
          <span className="ml-2 text-xs text-muted-foreground/60">v{process.env.APP_VERSION}</span>
        </div>
      </footer>

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
