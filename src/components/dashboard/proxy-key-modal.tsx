// Proxy Key Modal - Create or edit a proxy API key

"use client";

import { useState, useEffect, FormEvent } from "react";
import { X, Loader2, Copy, RefreshCw, Check } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { ChannelModelSelector, type ChannelWithModels } from "@/components/ui/channel-model-selector";
import { cn } from "@/lib/utils";

interface ProxyKeyData {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  allowAllModels: boolean;
  allowedChannelIds: string[] | null;
  allowedModelIds: string[] | null;
  unifiedMode?: boolean;
  allowedUnifiedModels?: string[] | null;
  temporaryStopValue?: number;
  temporaryStopUnit?: "second" | "minute" | "hour" | "day";
  unifiedRouteStrategy?: "round_robin" | "random";
  source?: "database" | "builtin" | "env" | "auto";
}

interface ProxyKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingKey: ProxyKeyData | null;
  onSuccess: () => void;
}

export function ProxyKeyModal({ isOpen, onClose, editingKey, onSuccess }: ProxyKeyModalProps) {
  const { token, authFetch } = useAuth();
  const { toast } = useToast();

  const [saving, setSaving] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [channels, setChannels] = useState<ChannelWithModels[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [allowAllModels, setAllowAllModels] = useState(true);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<Record<string, string[]>>({});

  const [unifiedMode, setUnifiedMode] = useState(true);
  const [temporaryStopValue, setTemporaryStopValue] = useState(10);
  const [temporaryStopUnit, setTemporaryStopUnit] = useState<"second" | "minute" | "hour" | "day">("minute");
  const [unifiedRouteStrategy, setUnifiedRouteStrategy] = useState<"round_robin" | "random">("round_robin");

  // Copy state
  const [copied, setCopied] = useState(false);
  const isBuiltInEdit = !!editingKey && editingKey.source !== "database";

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  // Load channels for selector
  useEffect(() => {
    if (!isOpen || !token) return;

    const controller = new AbortController();

    const loadChannels = async () => {
      setLoadingChannels(true);
      try {
        // 使用 /api/scheduler/config 获取渠道列表（包含 models 的 id 和 modelName）
        // /api/channel 只返回 lastStatus，不包含模型详情，无法满足 ChannelWithModels 接口
        const response = await authFetch("/api/scheduler/config", {
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) {
            setChannels(data.channels);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) {
          setLoadingChannels(false);
        }
      }
    };

    loadChannels();
    return () => controller.abort();
  }, [isOpen, token, authFetch]);

  // 初始化基础表单字段（仅在 editingKey/isOpen 变化时触发）
  useEffect(() => {
    if (editingKey) {
      setName(editingKey.name);
      setEnabled(editingKey.enabled);
      setAllowAllModels(editingKey.allowAllModels);
      setGeneratedKey(editingKey.source !== "database" ? editingKey.key : "");
      setUnifiedMode(editingKey.unifiedMode ?? true);
      setTemporaryStopValue(editingKey.temporaryStopValue ?? 10);
      setTemporaryStopUnit(editingKey.temporaryStopUnit ?? "minute");
      setUnifiedRouteStrategy(editingKey.unifiedRouteStrategy ?? "round_robin");
    } else {
      setName("");
      setEnabled(true);
      setAllowAllModels(true);
      setSelectedChannelIds([]);
      setSelectedModelIds({});
      setUnifiedMode(true);
      setTemporaryStopValue(10);
      setTemporaryStopUnit("minute");
      setUnifiedRouteStrategy("round_robin");
      // Auto-generate a key
      handleGenerateKey();
    }
  }, [editingKey, isOpen]);

  // 渠道加载完成后初始化模型选择（不覆盖基础字段）
  useEffect(() => {
    if (!editingKey || loadingChannels || channels.length === 0) return;

    const modelIds = editingKey.allowedModelIds;

    if (Array.isArray(modelIds) && modelIds.length > 0) {
      const groupedByChannel: Record<string, string[]> = {};
      for (const channel of channels) {
        const selectedInChannel = channel.models
          .filter(m => modelIds.includes(m.id))
          .map(m => m.id);
        if (selectedInChannel.length > 0) {
          groupedByChannel[channel.id] = selectedInChannel;
        }
      }
      setSelectedModelIds(groupedByChannel);
      setSelectedChannelIds(Object.keys(groupedByChannel));
    } else {
      setSelectedModelIds({});
      setSelectedChannelIds(editingKey.allowedChannelIds || []);
    }
  }, [editingKey, channels, loadingChannels]);

  // Generate a new key value
  const handleGenerateKey = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomValues = crypto.getRandomValues(new Uint8Array(48));
    let result = "sk-";
    for (let i = 0; i < 48; i++) {
      result += chars.charAt(randomValues[i] % chars.length);
    }
    setGeneratedKey(result);
  };

  // Copy key to clipboard
  const handleCopy = async () => {
    if (!generatedKey) return;
    await navigator.clipboard.writeText(generatedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle save
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast("请输入密钥名称", "error");
      return;
    }

    if ((isBuiltInEdit || !editingKey) && (!generatedKey.trim() || !generatedKey.startsWith("sk-"))) {
      toast("密钥值必须以 sk- 开头", "error");
      return;
    }

    // 计算有效的权限数据
    // 只有当渠道下所有模型都被选中时，才传递 channelId（避免 OR 逻辑导致返回整个渠道）
    const effectiveChannelIds = selectedChannelIds.filter(channelId => {
      const channel = channels.find(c => c.id === channelId);
      if (!channel) return false;
      const selectedModels = selectedModelIds[channelId] || [];
      return selectedModels.length === channel.models.length;
    });

    // 收集所有选中的 modelIds (扁平化)
    const effectiveModelIds = Object.values(selectedModelIds).flat();

    setSaving(true);
    try {
      if (editingKey) {
        const response = await authFetch(`/api/proxy-keys/${editingKey.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name.trim(),
            ...(isBuiltInEdit
              ? {
                  key: generatedKey.trim(),
                  enabled,
                  allowAllModels,
                  allowedChannelIds: allowAllModels ? null : (effectiveChannelIds.length > 0 ? effectiveChannelIds : null),
                  allowedModelIds: allowAllModels ? null : (effectiveModelIds.length > 0 ? effectiveModelIds : null),
                  unifiedMode,
                  allowedUnifiedModels: null,
                  temporaryStopValue,
                  temporaryStopUnit,
                  unifiedRouteStrategy,
                }
              : {
                  enabled,
                  allowAllModels,
                  allowedChannelIds: allowAllModels ? null : (effectiveChannelIds.length > 0 ? effectiveChannelIds : null),
                  allowedModelIds: allowAllModels ? null : (effectiveModelIds.length > 0 ? effectiveModelIds : null),
                  unifiedMode,
                  allowedUnifiedModels: null,
                  temporaryStopValue,
                  temporaryStopUnit,
                  unifiedRouteStrategy,
                }),
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "更新失败");
        }

        toast("密钥已更新", "success");
      } else {
        // Create new key
        const response = await authFetch("/api/proxy-keys", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name.trim(),
            key: generatedKey || undefined,
            enabled,
            allowAllModels,
            allowedChannelIds: allowAllModels ? null : (effectiveChannelIds.length > 0 ? effectiveChannelIds : null),
            allowedModelIds: allowAllModels ? null : (effectiveModelIds.length > 0 ? effectiveModelIds : null),
            unifiedMode,
            allowedUnifiedModels: null,
            temporaryStopValue,
            temporaryStopUnit,
            unifiedRouteStrategy,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "创建失败");
        }

        const data = await response.json();
        // Copy the key to clipboard
        if (data.key?.key) {
          await navigator.clipboard.writeText(data.key.key);
          toast("密钥已创建并复制到剪贴板", "success");
        } else {
          toast("密钥已创建", "success");
        }
      }

      onSuccess();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proxy-key-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-5xl mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 id="proxy-key-modal-title" className="text-lg font-semibold">
            {editingKey ? "编辑代理密钥" : "创建代理密钥"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-accent transition-colors"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  名称 <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                  placeholder="例如: 开发测试"
                  required
                />
              </div>

              {(!editingKey || isBuiltInEdit) && (
                <div>
                  <label className="block text-sm font-medium mb-1">密钥值</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={generatedKey}
                      onChange={(e) => setGeneratedKey(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm font-mono"
                      placeholder="sk-..."
                      readOnly={false}
                    />
                    <button
                      type="button"
                      onClick={handleGenerateKey}
                      className="p-2 rounded-md border border-input hover:bg-accent transition-colors"
                      title="生成新密钥"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="p-2 rounded-md border border-input hover:bg-accent transition-colors"
                      title="复制"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-md border border-border p-3 space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">启用此密钥</label>
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

                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium">统一模型模式</label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      开启后用户直接用模型名调用，系统自动跨渠道路由
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUnifiedMode(!unifiedMode)}
                    className={cn(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                      unifiedMode ? "bg-primary" : "bg-muted"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                        unifiedMode ? "translate-x-6" : "translate-x-1"
                      )}
                    />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">临时停止时长</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={temporaryStopValue}
                    onChange={(e) => setTemporaryStopValue(Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0))}
                    className="min-w-0 flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm"
                    placeholder="0 表示关闭"
                  />
                  <select
                    value={temporaryStopUnit}
                    onChange={(e) => setTemporaryStopUnit(e.target.value as "second" | "minute" | "hour" | "day")}
                    className="w-28 shrink-0 px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="second">秒</option>
                    <option value="minute">分钟</option>
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  临时异常命中后，当前代理 key 下的候选会暂停这么久；填 0 就是不启用临时停止
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">统一模式渠道策略</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setUnifiedRouteStrategy("round_robin")}
                    className={cn(
                      "px-3 py-2 rounded-md border text-sm transition-colors",
                      unifiedRouteStrategy === "round_robin"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input hover:bg-accent"
                    )}
                  >
                    轮询
                  </button>
                  <button
                    type="button"
                    onClick={() => setUnifiedRouteStrategy("random")}
                    className={cn(
                      "px-3 py-2 rounded-md border text-sm transition-colors",
                      unifiedRouteStrategy === "random"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input hover:bg-accent"
                    )}
                  >
                    随机
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  只影响统一模型模式下，同名模型跨渠道时的候选顺序
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">访问权限</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="accessMode"
                      checked={allowAllModels}
                      onChange={() => setAllowAllModels(true)}
                      className="w-4 h-4 text-primary"
                    />
                    <span className="text-sm">所有已检测可用模型</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="accessMode"
                      checked={!allowAllModels}
                      onChange={() => setAllowAllModels(false)}
                      className="w-4 h-4 text-primary"
                    />
                    <span className="text-sm">自定义权限</span>
                  </label>
                </div>
              </div>

              {!allowAllModels && (
                <div className="border border-border rounded-md p-3">
                  {loadingChannels ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {unifiedMode && (
                        <p className="text-xs text-muted-foreground">
                          统一模式下仍按渠道和模型授权，前台只是不需要再带渠道名前缀。
                        </p>
                      )}
                      <ChannelModelSelector
                        channels={channels}
                        selectedChannelIds={selectedChannelIds}
                        selectedModelIds={selectedModelIds}
                        onSelectionChange={(channelIds, modelIds) => {
                          setSelectedChannelIds(channelIds);
                          setSelectedModelIds(modelIds);
                        }}
                        selectAllLabel="全选所有渠道"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
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
              {editingKey ? "保存" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
