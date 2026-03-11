// Model filter modal - two-list layout with per-channel model selection and keyword filtering

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  X,
  Loader2,
  Plus,
  Minus,
  Check,
  Pencil,
  RefreshCw,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Search,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isAbortError, logWarn } from "@/lib/utils/error";

interface Keyword {
  id: string;
  keyword: string;
  enabled: boolean;
}

interface ChannelModelData {
  allModels: string[];
  manualSelectedModels: Set<string>;
  excludedAutoModels: Set<string>;
  modelPairs: Array<{ modelName: string; keyId: string | null }>;
}

interface ModelFilterModalProps {
  channels: { id: string; name: string }[];
  onClose: () => void;
  onBack?: () => void;
  onSyncComplete?: () => void;
}

export function ModelFilterModal({
  channels: targetChannels,
  onClose,
  onBack,
  onSyncComplete,
}: ModelFilterModalProps) {
  const { token, authFetch } = useAuth();
  const { toast } = useToast();
  const syncAbortRef = useRef<AbortController | null>(null);

  const [fetching, setFetching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fetchDone, setFetchDone] = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ completed: 0, total: 0, failed: 0 });
  const [syncProgress, setSyncProgress] = useState({ completed: 0, total: 0, failed: 0 });

  const [channelData, setChannelData] = useState<Map<string, ChannelModelData>>(new Map());
  const [collapsedLeft, setCollapsedLeft] = useState<Set<string>>(new Set());
  const [collapsedRight, setCollapsedRight] = useState<Set<string>>(new Set());

  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [selectedSearchText, setSelectedSearchText] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const headers = useMemo(
    () => ({ "Content-Type": "application/json" }),
    []
  );

  // Load keywords
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await authFetch("/api/model-keywords", { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setKeywords(data.keywords || []);
        }
      } catch (error) {
        if (isAbortError(error)) return;
        logWarn("[ModelFilter] 获取关键词失败", error);
      }
    })();
    return () => controller.abort();
  }, [token, authFetch]);

  // 组件卸载时取消同步请求
  useEffect(() => {
    return () => {
      syncAbortRef.current?.abort();
    };
  }, []);

  // Auto-fetch models on mount
  const fetchModels = useCallback(async (signal?: AbortSignal) => {
    if (targetChannels.length === 0) return;
    setFetching(true);
    setFetchDone(false);
    setFetchProgress({ completed: 0, total: targetChannels.length, failed: 0 });
    const newData = new Map<string, ChannelModelData>();

    try {
      const batchSize = 10;
      for (let i = 0; i < targetChannels.length; i += batchSize) {
        if (signal?.aborted) return;
        const batch = targetChannels.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (ch) => {
            const res = await authFetch(`/api/channel/${ch.id}/validate-keys`, {
              method: "POST",
              headers,
              signal,
            });
            if (!res.ok) throw new Error("获取失败");
            const data = await res.json();
            const models = new Set<string>();
            const modelPairMap = new Map<string, { modelName: string; keyId: string | null }>();
            for (const kr of (data.results || []) as { valid: boolean; keyId: string | null; models: string[] }[]) {
              if (kr.valid) {
                const keyId = typeof kr.keyId === "string" ? kr.keyId : null;
                for (const m of kr.models) {
                  models.add(m);
                  const pairKey = `${m}\u0000${keyId ?? "__main__"}`;
                  if (!modelPairMap.has(pairKey)) {
                    modelPairMap.set(pairKey, { modelName: m, keyId });
                  }
                }
              }
            }
            const allModels = Array.from(models).sort();
            const existingModels: string[] = data.existingModels || [];
            const preSelected = new Set<string>(
              existingModels.filter((m: string) => models.has(m))
            );
            return {
              channelId: ch.id,
              models: allModels,
              preSelected,
              modelPairs: Array.from(modelPairMap.values()),
            };
          })
        );

        let batchFailed = 0;
        results.forEach((result, idx) => {
          const ch = batch[idx];
          if (result.status === "fulfilled") {
            newData.set(result.value.channelId, {
              allModels: result.value.models,
              manualSelectedModels: result.value.preSelected,
              excludedAutoModels: new Set(),
              modelPairs: result.value.modelPairs,
            });
          } else {
            batchFailed++;
            newData.set(ch.id, {
              allModels: [],
              manualSelectedModels: new Set(),
              excludedAutoModels: new Set(),
              modelPairs: [],
            });
          }
        });
        setFetchProgress(prev => ({
          ...prev,
          completed: prev.completed + batch.length,
          failed: prev.failed + batchFailed,
        }));
      }

      setChannelData(newData);
      setFetchDone(true);
      const totalModels = Array.from(newData.values()).reduce((sum, d) => sum + d.allModels.length, 0);
      if (totalModels > 0) {
        toast(`获取到 ${totalModels} 个模型`, "success");
      } else {
        toast("未获取到任何模型", "error");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(err instanceof Error ? err.message : "获取失败", "error");
    } finally {
      setFetching(false);
    }
  }, [targetChannels, headers, toast, authFetch]);

  useEffect(() => {
    if (!token || targetChannels.length === 0) return;
    const controller = new AbortController();
    fetchModels(controller.signal);
    return () => controller.abort();
  }, [token, fetchModels, targetChannels.length]);

  // Filter logic
  const filterTerms = useMemo(() => {
    return keywords
      .filter((k) => selectedKeywordIds.has(k.id))
      .map((k) => k.keyword.toLowerCase());
  }, [keywords, selectedKeywordIds]);

  const matchesFilter = useCallback(
    (name: string) => {
      if (filterTerms.length === 0) return false;
      return filterTerms.some((term) => name.toLowerCase().includes(term));
    },
    [filterTerms]
  );

  const getSelectedSet = useCallback(
    (data: ChannelModelData) => {
      const selected = new Set(data.manualSelectedModels);
      for (const name of data.allModels) {
        if (matchesFilter(name) && !data.excludedAutoModels.has(name)) {
          selected.add(name);
        }
      }
      return selected;
    },
    [matchesFilter]
  );

  // Per-channel helpers
  const getAvailable = useCallback(
    (chId: string) => {
      const d = channelData.get(chId);
      if (!d) return [];
      const selected = getSelectedSet(d);
      return d.allModels.filter((n) => !selected.has(n));
    },
    [channelData, getSelectedSet]
  );

  const getSelected = useCallback(
    (chId: string) => {
      const d = channelData.get(chId);
      if (!d) return [];
      const selectedSet = getSelectedSet(d);
      const selected = d.allModels.filter((n) => selectedSet.has(n));
      if (!selectedSearchText.trim()) return selected;
      const term = selectedSearchText.trim().toLowerCase();
      return selected.filter((n) => n.toLowerCase().includes(term));
    },
    [channelData, getSelectedSet, selectedSearchText]
  );

  // Model actions
  const selectModel = (chId: string, name: string) => {
    setChannelData((prev) => {
      const next = new Map(prev);
      const d = next.get(chId);
      if (d) {
        const manualSelectedModels = new Set(d.manualSelectedModels);
        const excludedAutoModels = new Set(d.excludedAutoModels);
        manualSelectedModels.add(name);
        excludedAutoModels.delete(name);
        next.set(chId, { ...d, manualSelectedModels, excludedAutoModels });
      }
      return next;
    });
  };

  const deselectModel = (chId: string, name: string) => {
    setChannelData((prev) => {
      const next = new Map(prev);
      const d = next.get(chId);
      if (d) {
        const manualSelectedModels = new Set(d.manualSelectedModels);
        const excludedAutoModels = new Set(d.excludedAutoModels);
        manualSelectedModels.delete(name);
        if (matchesFilter(name)) {
          excludedAutoModels.add(name);
        } else {
          excludedAutoModels.delete(name);
        }
        next.set(chId, { ...d, manualSelectedModels, excludedAutoModels });
      }
      return next;
    });
  };

  const selectAllInChannel = (chId: string) => {
    setChannelData((prev) => {
      const next = new Map(prev);
      const d = next.get(chId);
      if (d) {
        const manualSelectedModels = new Set(d.manualSelectedModels);
        const excludedAutoModels = new Set(d.excludedAutoModels);
        const selected = getSelectedSet(d);
        for (const n of d.allModels) {
          if (!selected.has(n)) {
            manualSelectedModels.add(n);
            excludedAutoModels.delete(n);
          }
        }
        next.set(chId, { ...d, manualSelectedModels, excludedAutoModels });
      }
      return next;
    });
  };

  const deselectAllInChannel = (chId: string) => {
    setChannelData((prev) => {
      const next = new Map(prev);
      const d = next.get(chId);
      if (d) {
        next.set(chId, {
          ...d,
          manualSelectedModels: new Set(),
          excludedAutoModels: new Set(d.allModels.filter((name) => matchesFilter(name))),
        });
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    setChannelData((prev) => {
      const next = new Map(prev);
      for (const [chId, d] of next) {
        const manualSelectedModels = new Set(d.manualSelectedModels);
        const excludedAutoModels = new Set(d.excludedAutoModels);
        const selected = getSelectedSet(d);
        for (const n of d.allModels) {
          if (!selected.has(n)) {
            manualSelectedModels.add(n);
            excludedAutoModels.delete(n);
          }
        }
        next.set(chId, { ...d, manualSelectedModels, excludedAutoModels });
      }
      return next;
    });
  };

  const deselectAll = () => {
    setChannelData((prev) => {
      const next = new Map(prev);
      for (const [chId, d] of next) {
        next.set(chId, {
          ...d,
          manualSelectedModels: new Set(),
          excludedAutoModels: new Set(d.allModels.filter((name) => matchesFilter(name))),
        });
      }
      return next;
    });
  };

  // Collapse toggle
  const toggleCollapse = (side: "left" | "right", chId: string) => {
    const setter = side === "left" ? setCollapsedLeft : setCollapsedRight;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(chId)) next.delete(chId);
      else next.add(chId);
      return next;
    });
  };

  // Keyword CRUD
  const handleAddKeyword = async () => {
    if (!searchText.trim() || adding) return;
    setAdding(true);
    try {
      const res = await authFetch("/api/model-keywords", {
        method: "POST",
        headers,
        body: JSON.stringify({ keyword: searchText.trim() }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.keyword) {
        setKeywords((prev) => [data.keyword, ...prev]);
        setSelectedKeywordIds((prev) => new Set(prev).add(data.keyword.id));
      }
      setSearchText("");
    } catch (error) {
      logWarn("[ModelFilter] 添加关键词失败", error);
      toast("添加失败", "error");
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteKeyword = async (id: string) => {
    try {
      await authFetch(`/api/model-keywords?id=${id}`, { method: "DELETE", headers });
      setKeywords((prev) => prev.filter((k) => k.id !== id));
      setSelectedKeywordIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error) {
      logWarn("[ModelFilter] 删除关键词失败", error);
      toast("删除失败", "error");
    }
  };

  const handleToggleKeyword = (id: string) => {
    setSelectedKeywordIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleAllKeywords = () => {
    setSelectedKeywordIds(new Set(keywords.map((k) => k.id)));
  };

  const handleInvertKeywords = () => {
    setSelectedKeywordIds((prev) => {
      const next = new Set<string>();
      for (const keyword of keywords) {
        if (!prev.has(keyword.id)) {
          next.add(keyword.id);
        }
      }
      return next;
    });
  };

  const handleEditSave = async (id: string) => {
    if (!editValue.trim()) return;
    try {
      const res = await authFetch("/api/model-keywords", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id, keyword: editValue.trim() }),
      });
      if (!res.ok) throw new Error();
      setKeywords((prev) => prev.map((k) => (k.id === id ? { ...k, keyword: editValue.trim() } : k)));
      setEditingId(null);
    } catch (error) {
      logWarn("[ModelFilter] 保存关键词失败", error);
      toast("更新失败", "error");
    }
  };

  // Confirm sync - per channel
  const handleConfirmSync = async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    syncAbortRef.current = controller;
    setSyncing(true);
    setSyncProgress({ completed: 0, total: targetChannels.length, failed: 0 });
    try {
      let totalSynced = 0;
      let failedCount = 0;
      const batchSize = 10;

      for (let i = 0; i < targetChannels.length; i += batchSize) {
        if (signal.aborted) break;
        const batch = targetChannels.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (ch) => {
            const d = channelData.get(ch.id);
            const selectedSet = d ? getSelectedSet(d) : new Set<string>();
            const selected = Array.from(selectedSet);
            const selectedModelPairs = d
              ? d.modelPairs.filter((pair) => selectedSet.has(pair.modelName))
              : [];
            const res = await authFetch(`/api/channel/${ch.id}/sync`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                selectedModels: selected,
                selectedModelPairs,
              }),
              signal,
            });
            if (!res.ok) throw new Error();
            const data = await res.json();
            return data.total || 0;
          })
        );
        let batchFailed = 0;
        for (const result of results) {
          if (result.status === "fulfilled") totalSynced += result.value;
          else { failedCount++; batchFailed++; }
        }
        setSyncProgress(prev => ({
          ...prev,
          completed: prev.completed + batch.length,
          failed: prev.failed + batchFailed,
        }));
      }

      if (signal.aborted) return;

      if (targetChannels.length > 1) {
        toast(
          failedCount > 0
            ? `全量同步完成，${totalSynced} 个模型，${failedCount} 个渠道失败`
            : `全量同步完成，保存了 ${totalSynced} 个模型`,
          failedCount > 0 ? "error" : "success"
        );
      } else {
        toast(`同步完成，保存了 ${totalSynced} 个模型`, "success");
      }
      onSyncComplete?.();
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(err instanceof Error ? err.message : "同步失败", "error");
    } finally {
      syncAbortRef.current = null;
      setSyncing(false);
    }
  };

  // Stats
  const totalSelected = useMemo(() => {
    let count = 0;
    for (const d of channelData.values()) count += getSelectedSet(d).size;
    return count;
  }, [channelData, getSelectedSet]);

  const totalFetched = useMemo(() => {
    let count = 0;
    for (const d of channelData.values()) count += d.allModels.length;
    return count;
  }, [channelData]);

  const allKeywordsEnabled = keywords.length > 0 && selectedKeywordIds.size === keywords.length;
  const isMultiChannel = targetChannels.length > 1;

  // Render channel model list for left column (available)
  const renderAvailableList = () => {
    if (isMultiChannel) {
      const hasAny = targetChannels.some((ch) => (channelData.get(ch.id)?.allModels.length ?? 0) > 0);
      if (!hasAny) return <p className="text-sm text-muted-foreground text-center py-8">无可选模型</p>;
      return targetChannels.map((ch) => {
        const allModels = channelData.get(ch.id)?.allModels || [];
        if (allModels.length === 0) return null;
        const available = getAvailable(ch.id);
        const collapsed = collapsedLeft.has(ch.id);
        return (
          <div key={ch.id}>
            <div
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-muted/90 backdrop-blur-sm border-b border-border cursor-pointer select-none"
              onClick={() => toggleCollapse("left", ch.id)}
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
              <span className="text-xs font-medium flex-1 truncate">{ch.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">{available.length}</span>
              <button
                onClick={(e) => { e.stopPropagation(); selectAllInChannel(ch.id); }}
                className="text-xs px-1.5 py-0 rounded border border-input bg-background hover:bg-accent transition-colors shrink-0"
              >
                全选
              </button>
            </div>
            {!collapsed && (
              available.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-2">无可选模型</p>
              ) : (
                available.map((name) => (
                  <div
                    key={`${ch.id}-${name}`}
                    onClick={() => selectModel(ch.id, name)}
                    className="flex items-center gap-2 px-3 py-1 hover:bg-accent/50 cursor-pointer transition-colors border-b border-border last:border-b-0"
                  >
                    <span className="text-sm font-mono flex-1 truncate">{name}</span>
                    <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </div>
                ))
              )
            )}
          </div>
        );
      });
    }

    // Single channel - flat list
    const chId = targetChannels[0]?.id;
    if (!chId) return null;
    const available = getAvailable(chId);
    if (available.length === 0) {
      return (
        <p className="text-sm text-muted-foreground text-center py-8">
          所有模型已选择
        </p>
      );
    }
    return available.map((name) => (
      <div
        key={name}
        onClick={() => selectModel(chId, name)}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 cursor-pointer transition-colors border-b border-border last:border-b-0"
      >
        <span className="text-sm font-mono flex-1 truncate">{name}</span>
        <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </div>
    ));
  };

  // Render channel model list for right column (selected)
  const renderSelectedList = () => {
    if (isMultiChannel) {
      return targetChannels.map((ch) => {
        const selected = getSelected(ch.id);
        if (selected.length === 0) return null;
        const collapsed = collapsedRight.has(ch.id);
        return (
          <div key={ch.id}>
            <div
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-muted/90 backdrop-blur-sm border-b border-border cursor-pointer select-none"
              onClick={() => toggleCollapse("right", ch.id)}
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
              <span className="text-xs font-medium flex-1 truncate">{ch.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">{selected.length}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deselectAllInChannel(ch.id); }}
                className="text-xs px-1.5 py-0 rounded border border-input bg-background hover:bg-accent transition-colors shrink-0"
              >
                清空
              </button>
            </div>
            {!collapsed && selected.map((name) => (
              <div
                key={`${ch.id}-${name}`}
                onClick={() => deselectModel(ch.id, name)}
                className="flex items-center gap-2 px-3 py-1 hover:bg-red-500/5 cursor-pointer transition-colors border-b border-border last:border-b-0"
              >
                <span className="text-sm font-mono flex-1 truncate">{name}</span>
                <Minus className="h-3.5 w-3.5 text-red-500 shrink-0" />
              </div>
            ))}
          </div>
        );
      });
    }

    // Single channel - flat list
    const chId = targetChannels[0]?.id;
    if (!chId) return null;
    const selected = getSelected(chId);
    if (selected.length === 0) return null;
    return selected.map((name) => (
      <div
        key={name}
        onClick={() => deselectModel(chId, name)}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-red-500/5 cursor-pointer transition-colors border-b border-border last:border-b-0"
      >
        <span className="text-sm font-mono flex-1 truncate">{name}</span>
        <Minus className="h-3.5 w-3.5 text-red-500 shrink-0" />
      </div>
    ));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="filter-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative bg-card rounded-lg shadow-xl border border-border w-[900px] max-w-[95vw] m-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="返回"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            <h2 id="filter-modal-title" className="text-lg font-semibold flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-blue-500" />
              {isMultiChannel ? `全量同步 - 选择模型 (${targetChannels.length} 个渠道)` : "获取模型"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-accent transition-colors"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden px-5 py-4 flex flex-col min-h-0">
          {/* Keyword bar */}
          <div className="space-y-2 shrink-0 mb-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddKeyword(); }
                }}
                className="flex-1 px-3 py-1.5 rounded-md border border-input bg-background text-sm"
                placeholder="输入关键词名称，回车保存..."
              />
              <button
                onClick={handleAddKeyword}
                disabled={adding || !searchText.trim()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </div>
            {keywords.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={handleToggleAllKeywords}
                  disabled={allKeywordsEnabled}
                  className="text-xs px-1.5 py-0.5 rounded border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors text-muted-foreground"
                >
                  全选
                </button>
                <button
                  onClick={handleInvertKeywords}
                  className="text-xs px-1.5 py-0.5 rounded border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors text-muted-foreground"
                >
                  反选
                </button>
                {keywords.map((kw) => (
                  <div
                    key={kw.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs cursor-pointer transition-colors",
                      selectedKeywordIds.has(kw.id)
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-muted text-muted-foreground"
                    )}
                  >
                    {editingId === kw.id ? (
                      <>
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEditSave(kw.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="w-16 px-1 py-0 border border-input rounded text-xs bg-background"
                          autoFocus
                        />
                        <button onClick={() => handleEditSave(kw.id)} className="hover:text-primary"><Check className="h-3 w-3" /></button>
                        <button onClick={() => setEditingId(null)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleToggleKeyword(kw.id)}
                          className={cn("transition-colors", !selectedKeywordIds.has(kw.id) && "line-through")}
                        >
                          {kw.keyword}
                        </button>
                        <button onClick={() => { setEditingId(kw.id); setEditValue(kw.keyword); }} className="hover:text-primary"><Pencil className="h-2.5 w-2.5" /></button>
                        <button onClick={() => handleDeleteKeyword(kw.id)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Model lists */}
          {fetching ? (
            <div className="flex flex-col items-center justify-center py-12 flex-1 gap-4">
              <div className="flex items-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {isMultiChannel
                    ? `正在获取模型 (${fetchProgress.completed}/${fetchProgress.total} 个渠道)${fetchProgress.failed > 0 ? `，${fetchProgress.failed} 个失败` : ""}`
                    : "正在获取模型..."}
                </span>
              </div>
              {isMultiChannel && fetchProgress.total > 0 && (
                <div className="w-64">
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${(fetchProgress.completed / fetchProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center mt-1">
                    {Math.round((fetchProgress.completed / fetchProgress.total) * 100)}%
                  </p>
                </div>
              )}
            </div>
          ) : totalFetched > 0 ? (
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
              {/* Left - Available */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <h3 className="text-sm font-medium">
                    获取的模型
                    {filterTerms.length > 0 && <span className="text-muted-foreground ml-1">(右侧已自动加入标签命中项)</span>}
                  </h3>
                  <button
                    onClick={selectAllVisible}
                    className="text-xs px-2 py-0.5 rounded border border-input bg-background hover:bg-accent transition-colors"
                  >
                    全选
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto rounded-md border border-border" style={{ minHeight: "200px", maxHeight: "400px" }}>
                  {renderAvailableList()}
                </div>
              </div>

              {/* Right - Selected */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <h3 className="text-sm font-medium">已选模型 ({totalSelected})</h3>
                  <button
                    onClick={deselectAll}
                    disabled={totalSelected === 0}
                    className="text-xs px-2 py-0.5 rounded border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors"
                  >
                    清空
                  </button>
                </div>
                <div className="relative mb-2 shrink-0">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={selectedSearchText}
                    onChange={(e) => setSelectedSearchText(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 rounded-md border border-input bg-background text-sm"
                    placeholder="搜索已选模型..."
                  />
                </div>
                <div className="flex-1 overflow-y-auto rounded-md border border-border" style={{ minHeight: "200px", maxHeight: "400px" }}>
                  {renderSelectedList()}
                  {totalSelected === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      点击上方标签或左侧模型添加
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : fetchDone ? (
            <p className="text-sm text-muted-foreground text-center py-8 flex-1">
              未获取到任何模型
            </p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border shrink-0 space-y-2">
          {syncing && isMultiChannel && syncProgress.total > 0 && (
            <div>
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>正在同步 ({syncProgress.completed}/{syncProgress.total} 个渠道){syncProgress.failed > 0 ? `，${syncProgress.failed} 个失败` : ""}</span>
                <span>{Math.round((syncProgress.completed / syncProgress.total) * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${(syncProgress.completed / syncProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
          >
            跳过
          </button>
          <button
            onClick={handleConfirmSync}
            disabled={syncing || totalSelected === 0}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {syncing && <Loader2 className="h-4 w-4 animate-spin" />}
            确认并同步 ({totalSelected})
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
