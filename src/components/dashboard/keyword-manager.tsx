// Keyword manager component - CRUD for model filtering keywords

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  Tag,
  Pencil,
  Check,
  CheckSquare,
  Square,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface Keyword {
  id: string;
  keyword: string;
  enabled: boolean;
}

export function KeywordManager({ className }: { className?: string }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(false);

  // Add state
  const [newKeyword, setNewKeyword] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Toggling state
  const [togglingAll, setTogglingAll] = useState(false);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const fetchKeywords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/model-keywords", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setKeywords(data.keywords || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isExpanded && token) {
      fetchKeywords();
    }
  }, [isExpanded, token, fetchKeywords]);

  const handleAdd = async () => {
    if (!newKeyword.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/model-keywords", {
        method: "POST",
        headers,
        body: JSON.stringify({ keyword: newKeyword.trim() }),
      });
      if (!res.ok) throw new Error();
      setNewKeyword("");
      fetchKeywords();
    } catch {
      toast("添加失败", "error");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/model-keywords?id=${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error();
      setKeywords((prev) => prev.filter((k) => k.id !== id));
    } catch {
      toast("删除失败", "error");
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    // Optimistic update
    setKeywords((prev) => prev.map((k) => (k.id === id ? { ...k, enabled } : k)));
    try {
      const res = await fetch("/api/model-keywords", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id, enabled }),
      });
      if (!res.ok) throw new Error();
    } catch {
      // Revert on error
      setKeywords((prev) => prev.map((k) => (k.id === id ? { ...k, enabled: !enabled } : k)));
      toast("更新失败", "error");
    }
  };

  const handleToggleAll = async (enabled: boolean) => {
    setTogglingAll(true);
    const previous = keywords.map((k) => ({ ...k }));
    setKeywords((prev) => prev.map((k) => ({ ...k, enabled })));
    try {
      const res = await fetch("/api/model-keywords/toggle-all", {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setKeywords(previous);
      toast("批量更新失败", "error");
    } finally {
      setTogglingAll(false);
    }
  };

  const handleEditSave = async (id: string) => {
    if (!editValue.trim()) return;
    try {
      const res = await fetch("/api/model-keywords", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id, keyword: editValue.trim() }),
      });
      if (!res.ok) throw new Error();
      setKeywords((prev) =>
        prev.map((k) => (k.id === id ? { ...k, keyword: editValue.trim() } : k))
      );
      setEditingId(null);
    } catch {
      toast("更新失败", "error");
    }
  };

  const allEnabled = keywords.length > 0 && keywords.every((k) => k.enabled);
  const noneEnabled = keywords.length > 0 && keywords.every((k) => !k.enabled);

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 p-4 overflow-hidden">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center justify-between gap-2 hover:bg-accent/50 px-3 py-2 -ml-3 rounded transition-colors min-w-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Tag className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">关键词筛选</span>
            {keywords.length > 0 && (
              <span className="text-sm text-muted-foreground shrink-0">
                ({keywords.filter((k) => k.enabled).length}/{keywords.length})
              </span>
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Hint */}
          <p className="text-xs text-muted-foreground">
            启用的关键词用于同步时筛选模型名称（模糊匹配），无关键词则保留所有模型。
          </p>

          {/* Add input */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="flex-1 px-3 py-1.5 rounded-md border border-input bg-background text-sm"
              placeholder="输入关键词，如 gpt、claude..."
            />
            <button
              onClick={handleAdd}
              disabled={adding || !newKeyword.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              添加
            </button>
          </div>

          {/* Toggle all buttons */}
          {keywords.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleToggleAll(true)}
                disabled={togglingAll || allEnabled}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors"
              >
                <CheckSquare className="h-3.5 w-3.5" />
                全选
              </button>
              <button
                onClick={() => handleToggleAll(false)}
                disabled={togglingAll || noneEnabled}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors"
              >
                <Square className="h-3.5 w-3.5" />
                全不选
              </button>
            </div>
          )}

          {/* Keyword list */}
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              暂无关键词，同步时将保留所有模型
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {keywords.map((kw) => (
                <div
                  key={kw.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-sm transition-colors",
                    kw.enabled
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border bg-muted text-muted-foreground"
                  )}
                >
                  {/* Toggle checkbox */}
                  <button
                    onClick={() => handleToggle(kw.id, !kw.enabled)}
                    className="shrink-0"
                    title={kw.enabled ? "禁用" : "启用"}
                  >
                    {kw.enabled ? (
                      <CheckSquare className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                  </button>

                  {/* Keyword text or edit input */}
                  {editingId === kw.id ? (
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleEditSave(kw.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-20 px-1 py-0 border border-input rounded text-sm bg-background"
                      autoFocus
                    />
                  ) : (
                    <span className={cn(!kw.enabled && "line-through")}>{kw.keyword}</span>
                  )}

                  {/* Action buttons */}
                  {editingId === kw.id ? (
                    <>
                      <button onClick={() => handleEditSave(kw.id)} className="shrink-0 hover:text-primary">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="shrink-0 hover:text-destructive">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(kw.id);
                          setEditValue(kw.keyword);
                        }}
                        className="shrink-0 hover:text-primary"
                        title="编辑"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleDelete(kw.id)}
                        className="shrink-0 hover:text-destructive"
                        title="删除"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
