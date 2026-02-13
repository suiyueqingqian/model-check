// Channel manager component - Add, edit, delete, sync channels

"use client";

import { useState, useEffect, useCallback, FormEvent } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  Settings,
  Copy,
  Check,
  Download,
  Upload,
  Cloud,
  Key,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { ModelFilterModal } from "@/components/dashboard/model-filter-modal";
import { cn } from "@/lib/utils";

interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  enabled: boolean;
  models?: { lastStatus: boolean | null }[];
  sortOrder?: number;
  keyMode?: string;
  routeStrategy?: string;
  _count?: { models: number; channelKeys: number };
}

interface ChannelManagerProps {
  onUpdate: () => void;
  className?: string;
}

interface ChannelFormData {
  name: string;
  baseUrl: string;
  proxy: string;
  routeStrategy: "round_robin" | "random";
  multiKeys: string;
}

interface ChannelKeyInfo {
  id: string;
  maskedKey: string;
  fullKey: string;
  lastValid: boolean | null;
}

interface ValidateResult {
  keyId: string | null;
  maskedKey: string;
  valid: boolean;
  modelCount: number;
  models: string[];
  error?: string;
}

const initialFormData: ChannelFormData = {
  name: "",
  baseUrl: "",
  proxy: "",
  routeStrategy: "round_robin",
  multiKeys: "",
};

function getChannelBorderClass(channel: Channel): string {
  if ((channel._count?.models ?? 0) === 0) {
    return "border-red-500";
  }

  const statuses = channel.models?.map((m) => m.lastStatus) || [];
  if (statuses.length === 0) {
    return "border-border";
  }

  const availableCount = statuses.filter((status) => status === true).length;
  const unavailableCount = statuses.filter((status) => status === false).length;

  if (availableCount === statuses.length) {
    return "border-green-500";
  }

  if (unavailableCount === statuses.length) {
    return "border-red-500";
  }

  if (availableCount > 0 && availableCount < statuses.length) {
    return "border-yellow-500";
  }

  return "border-border";
}

export function ChannelManager({ onUpdate, className }: ChannelManagerProps) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [formData, setFormData] = useState<ChannelFormData>(initialFormData);
  const [submitting, setSubmitting] = useState(false);

  // Sync state
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  // Per-channel sync status message (shown on the channel card)
  const [syncStatus, setSyncStatus] = useState<Record<string, { message: string; type: "success" | "error" }>>({});
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Copy API key state
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Import/Export state
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [importText, setImportText] = useState("");

  // Channel keys info (for multi-key edit display)
  const [channelKeysInfo, setChannelKeysInfo] = useState<ChannelKeyInfo[]>([]);
  const [validating, setValidating] = useState(false);
  const [validateResults, setValidateResults] = useState<ValidateResult[]>([]);
  const [maskedApiKey, setMaskedApiKey] = useState<string>("");

  // Key management in edit modal
  const [keyViewMode, setKeyViewMode] = useState<"list" | "edit">("list");
  const [newSingleKey, setNewSingleKey] = useState("");
  const [addingSingleKey, setAddingSingleKey] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [mainKeyFull, setMainKeyFull] = useState<string>("");
  const [editingKeyTarget, setEditingKeyTarget] = useState<string | null>(null); // "main" | keyId
  const [editKeyValue, setEditKeyValue] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);

  // Model filter modal state
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterChannels, setFilterChannels] = useState<{ id: string; name: string }[]>([]);
  const [syncAllMode, setSyncAllMode] = useState(false);
  const [filterFromEdit, setFilterFromEdit] = useState(false);

  // Pagination state
  const [channelPage, setChannelPage] = useState(1);
  const CHANNELS_PER_PAGE = 12;

  // 云通知 state
  const [showWebDAVModal, setShowWebDAVModal] = useState(false);
  const [webdavUploading, setWebdavUploading] = useState(false);
  const [webdavDownloading, setWebdavDownloading] = useState(false);
  const [webdavConfig, setWebdavConfig] = useState({
    url: "",
    username: "",
    password: "",
    filename: "channels.json",
  });
  const [webdavEnvConfigured, setWebdavEnvConfigured] = useState(false);
  const [webdavMode, setWebdavMode] = useState<"merge" | "replace">("merge");

  // Handle ESC key to close modals
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showModal) setShowModal(false);
        if (showImportModal) setShowImportModal(false);
        if (showWebDAVModal) setShowWebDAVModal(false);
        if (showFilterModal) setShowFilterModal(false);
      }
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [showModal, showImportModal, showWebDAVModal, showFilterModal]);

  // Load cloud sync config from localStorage and API
  useEffect(() => {
    const loadWebdavConfig = async () => {
      // First load from localStorage
      let config = {
        url: "",
        username: "",
        password: "",
        filename: "channels.json",
      };

      if (typeof window !== "undefined") {
        const saved = sessionStorage.getItem("webdav-config");
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            config = { ...config, ...parsed };
          } catch {
            // ignore parse errors
          }
        }
      }

      // Then try to get env config from API
      if (token) {
        try {
          const response = await fetch("/api/channel/webdav", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.ok) {
            const envConfig = await response.json();
            setWebdavEnvConfigured(envConfig.configured);

            // Use env config as default if localStorage is empty
            if (!config.url && envConfig.url) {
              config.url = envConfig.url;
            }
            if (!config.username && envConfig.username) {
              config.username = envConfig.username;
            }
            if (!config.filename && envConfig.filename) {
              config.filename = envConfig.filename;
            }
            // Don't load password from env for security, but show hint
          }
        } catch {
          // ignore API errors
        }
      }

      setWebdavConfig(config);
    };

    loadWebdavConfig();
  }, [token]);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // Fetch channels
  const fetchChannels = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/channel", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal,
      });
      if (!response.ok) throw new Error("获取渠道列表失败");
      const data = await response.json();
      if (!signal?.aborted) {
        setChannels(data.channels || []);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : "未知错误");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (isExpanded && token) {
      const controller = new AbortController();
      fetchChannels(controller.signal);
      return () => controller.abort();
    }
  }, [isExpanded, token, fetchChannels]);

  // Open add modal
  const handleAdd = () => {
    setEditingChannel(null);
    setFormData(initialFormData);
    setMaskedApiKey("");
    setMainKeyFull("");
    setChannelKeysInfo([]);
    setValidateResults([]);
    setShowModal(true);
  };

  // Open edit modal
  const handleEdit = async (channel: Channel) => {
    setEditingChannel(channel);
    setMaskedApiKey(channel.apiKey);
    setMainKeyFull("");
    setFormData({
      name: channel.name,
      baseUrl: channel.baseUrl,
      proxy: channel.proxy || "",
      routeStrategy: (channel.routeStrategy as "round_robin" | "random") || "round_robin",
      multiKeys: "",
    });
    setChannelKeysInfo([]);
    setValidateResults([]);
    setKeyViewMode("list");
    setNewSingleKey("");
    setEditingKeyTarget(null);
    setShowModal(true);
    // Load existing keys (full values) + main key
    try {
      const [keysRes, mainKeyRes] = await Promise.all([
        fetch(`/api/channel/${channel.id}/keys`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`/api/channel/${channel.id}/key`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (keysRes.ok) {
        const data = await keysRes.json();
        if (data.keys?.length > 0) {
          setChannelKeysInfo(data.keys.map((k: { id: string; maskedKey: string; fullKey: string; lastValid?: boolean | null }) => ({
            id: k.id,
            maskedKey: k.maskedKey,
            fullKey: k.fullKey,
            lastValid: k.lastValid ?? null,
          })));
        }
      }
      if (mainKeyRes.ok) {
        const data = await mainKeyRes.json();
        if (data.apiKey) {
          setMainKeyFull(data.apiKey);
        }
      }
    } catch {
      // ignore
    }
  };

  // Submit form (create or update)
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (editingChannel) {
        // Update
        const updateBody: Record<string, unknown> = {
          id: editingChannel.id,
          name: formData.name,
          baseUrl: formData.baseUrl,
          proxy: formData.proxy || null,
          keyMode: "multi",
          routeStrategy: formData.routeStrategy,
        };

        // Send keys if textarea has content (works in both edit and list mode after editing)
        let keysSubmitted = false;
        if (formData.multiKeys.trim()) {
          const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
          if (keyList.length > 0) {
            updateBody.apiKey = keyList[0];
            updateBody.keys = formData.multiKeys;
            keysSubmitted = true;
          }
        }
        // In list mode, keys are managed individually via API, no need to send

        const response = await fetch("/api/channel", {
          method: "PUT",
          headers,
          body: JSON.stringify(updateBody),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "更新渠道失败");
        }

        setShowModal(false);
        // 只有本次提交了 keys 才打开模型选择页面，否则直接保存关闭
        if (keysSubmitted) {
          setFilterChannels([{ id: editingChannel.id, name: editingChannel.name }]);
          setFilterFromEdit(true);
          setSyncAllMode(false);
          setShowFilterModal(true);
        }
      } else {
        // Create - always use textarea
        const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
        if (keyList.length === 0) {
          throw new Error("请至少输入一个 API Key");
        }
        const createBody: Record<string, unknown> = {
          name: formData.name,
          baseUrl: formData.baseUrl,
          apiKey: keyList[0],
          proxy: formData.proxy || null,
          keyMode: "multi",
          routeStrategy: formData.routeStrategy,
          keys: formData.multiKeys,
        };

        const response = await fetch("/api/channel", {
          method: "POST",
          headers,
          body: JSON.stringify(createBody),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "创建渠道失败");
        }

        const createData = await response.json();
        if (createData.channel?.id) {
          setShowModal(false);
          setFilterChannels([{ id: createData.channel.id, name: formData.name }]);
          setFilterFromEdit(false);
          setSyncAllMode(false);
          setShowFilterModal(true);
        } else {
          setShowModal(false);
        }
      }

      fetchChannels();
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  };

  // Validate keys
  const handleValidateKeys = async () => {
    if (!editingChannel || validating) return;
    setValidating(true);
    setValidateResults([]);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/validate-keys`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error("验证失败");
      const data = await res.json();
      const results: ValidateResult[] = data.results || [];
      setValidateResults(results);
      // Update channelKeysInfo lastValid based on results
      setChannelKeysInfo((prev) =>
        prev.map((k) => {
          const result = results.find((r) => r.keyId === k.id);
          if (result) return { ...k, lastValid: result.valid };
          return k;
        })
      );
      // Simplified result toast
      const validCount = results.filter((r) => r.valid).length;
      const invalidCount = results.filter((r) => !r.valid).length;
      toast(`验证完成：${validCount} 个有效，${invalidCount} 个无效`, validCount > 0 ? "success" : "error");
    } catch (err) {
      toast(err instanceof Error ? err.message : "验证失败", "error");
    } finally {
      setValidating(false);
    }
  };

  // Add single key to existing channel
  const handleAddSingleKey = async () => {
    if (!editingChannel || !newSingleKey.trim() || addingSingleKey) return;
    setAddingSingleKey(true);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ apiKey: newSingleKey.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "添加失败");
      }
      const data = await res.json();
      const fullKeyValue = newSingleKey.trim();
      setChannelKeysInfo((prev) => [
        ...prev,
        {
          id: data.key.id,
          maskedKey: data.key.apiKey,
          fullKey: fullKeyValue,
          lastValid: null,
        },
      ]);
      setNewSingleKey("");
      toast("Key 已添加", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "添加失败", "error");
    } finally {
      setAddingSingleKey(false);
    }
  };

  // Delete single key
  const handleDeleteSingleKey = async (keyId: string) => {
    if (!editingChannel) return;
    setDeletingKeyId(keyId);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${keyId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("删除失败");
      setChannelKeysInfo((prev) => prev.filter((k) => k.id !== keyId));
      setValidateResults((prev) => prev.filter((r) => r.keyId !== keyId));
      toast("Key 已删除", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    } finally {
      setDeletingKeyId(null);
    }
  };

  // Delete main key: promote first extra key to main, then delete it from channelKey
  const [deletingMainKey, setDeletingMainKey] = useState(false);
  const handleDeleteMainKey = async () => {
    if (!editingChannel || deletingMainKey) return;
    if (channelKeysInfo.length === 0) {
      toast("没有其他 Key 可提升为主 Key，无法删除", "error");
      return;
    }
    setDeletingMainKey(true);
    try {
      const firstExtra = channelKeysInfo[0];
      // Promote first extra key to main key
      const res = await fetch("/api/channel", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: editingChannel.id, apiKey: firstExtra.fullKey }),
      });
      if (!res.ok) throw new Error("更新失败");
      // Delete the promoted key from channelKey table
      await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${firstExtra.id}`, {
        method: "DELETE",
        headers,
      });
      // Update local state
      setMainKeyFull(firstExtra.fullKey);
      const masked = firstExtra.fullKey.length > 12
        ? firstExtra.fullKey.slice(0, 8) + "..." + firstExtra.fullKey.slice(-4)
        : "***";
      setMaskedApiKey(masked);
      setChannelKeysInfo((prev) => prev.filter((k) => k.id !== firstExtra.id));
      toast("主 Key 已删除，已提升下一个 Key 为主 Key", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error");
    } finally {
      setDeletingMainKey(false);
    }
  };

  // Batch delete invalid keys
  const handleBatchDeleteInvalid = async () => {
    if (!editingChannel) return;
    const invalidKeys = channelKeysInfo.filter((k) => k.lastValid === false);
    if (invalidKeys.length === 0) return;
    setBatchDeleting(true);
    let deleted = 0;
    for (const k of invalidKeys) {
      try {
        await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${k.id}`, {
          method: "DELETE",
          headers,
        });
        deleted++;
      } catch {
        // continue
      }
    }
    const deletedIds = new Set(invalidKeys.map((k) => k.id));
    setChannelKeysInfo((prev) => prev.filter((k) => !deletedIds.has(k.id)));
    setValidateResults((prev) => prev.filter((r) => !r.keyId || !deletedIds.has(r.keyId)));
    toast(`已删除 ${deleted} 个无效 Key`, "success");
    setBatchDeleting(false);
  };

  // Save inline key edit
  const handleEditKeySave = async () => {
    if (!editingChannel || !editingKeyTarget || !editKeyValue.trim()) return;
    try {
      if (editingKeyTarget === "main") {
        // Update main key via channel API
        const res = await fetch("/api/channel", {
          method: "PUT",
          headers,
          body: JSON.stringify({ id: editingChannel.id, apiKey: editKeyValue.trim() }),
        });
        if (!res.ok) throw new Error("更新失败");
        setMainKeyFull(editKeyValue.trim());
        const masked = editKeyValue.trim().length > 12
          ? editKeyValue.trim().slice(0, 8) + "..." + editKeyValue.trim().slice(-4)
          : "***";
        setMaskedApiKey(masked);
      } else {
        // Update extra key
        const res = await fetch(`/api/channel/${editingChannel.id}/keys`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ keyId: editingKeyTarget, apiKey: editKeyValue.trim() }),
        });
        if (!res.ok) throw new Error("更新失败");
        const masked = editKeyValue.trim().length > 12
          ? editKeyValue.trim().slice(0, 8) + "..." + editKeyValue.trim().slice(-4)
          : "***";
        setChannelKeysInfo((prev) =>
          prev.map((k) =>
            k.id === editingKeyTarget
              ? { ...k, fullKey: editKeyValue.trim(), maskedKey: masked }
              : k
          )
        );
      }
      setEditingKeyTarget(null);
      toast("Key 已更新", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "更新失败", "error");
    }
  };

  // Save keys from textarea (edit mode) without closing modal
  const handleSaveKeysFromTextarea = async () => {
    if (!editingChannel || savingKeys) return;
    const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
    if (keyList.length === 0) {
      toast("请至少输入一个 Key", "error");
      return;
    }
    setSavingKeys(true);
    try {
      const res = await fetch("/api/channel", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          id: editingChannel.id,
          apiKey: keyList[0],
          keyMode: "multi",
          keys: formData.multiKeys,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "保存失败");
      }
      toast(`已保存 ${keyList.length} 个 Key`, "success");
      setFormData((prev) => ({ ...prev, multiKeys: "" }));
      fetchChannels();
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setSavingKeys(false);
    }
  };

  // Delete channel
  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`/api/channel?id=${id}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok) throw new Error("删除渠道失败");

      setDeleteConfirm(null);
      fetchChannels();
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  };

  // Sync models
  const handleSync = async (id: string) => {
    setSyncingId(id);
    // Clear any previous status for this channel
    setSyncStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const response = await fetch(`/api/channel/${id}/sync`, {
        method: "POST",
        headers,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "同步失败");

      toast(`获取到 ${data.total} 个模型`, "success");
    } catch (err) {
      // Show error message on the channel card instead of global error
      const message = err instanceof Error ? err.message : "同步失败";
      setSyncStatus((prev) => ({ ...prev, [id]: { message, type: "error" } }));

      // Auto clear after 8 seconds for errors
      setTimeout(() => {
        setSyncStatus((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 8000);
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncAll = async () => {
    if (syncingAll || channels.length === 0) return;

    setSyncingAll(true);
    setError(null);

    try {
      const concurrency = 3;
      let totalModels = 0;
      let failedCount = 0;

      for (let index = 0; index < channels.length; index += concurrency) {
        const batch = channels.slice(index, index + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (channel) => {
            const response = await fetch(`/api/channel/${channel.id}/sync`, {
              method: "POST",
              headers,
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.error || "同步失败");
            }
            return Number(data.total) || 0;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            totalModels += result.value;
          } else {
            failedCount += 1;
          }
        }
      }

      if (failedCount > 0) {
        toast(`全量同步完成，获取到 ${totalModels} 个模型，${failedCount} 个渠道失败`, "error");
      } else {
        toast(`全量同步完成，获取到 ${totalModels} 个模型`, "success");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "全量同步失败", "error");
    } finally {
      setSyncingAll(false);
      onUpdate();
    }
  };

  const persistChannelOrder = async (orderedChannels: Channel[]) => {
    const orders = orderedChannels.map((channel, index) => ({
      id: channel.id,
      sortOrder: index,
    }));

    const response = await fetch("/api/channel", {
      method: "PUT",
      headers,
      body: JSON.stringify({ orders }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "排序保存失败");
    }
  };

  const handleDropChannel = async (targetChannelId: string) => {
    if (!draggingChannelId || draggingChannelId === targetChannelId) {
      setDraggingChannelId(null);
      return;
    }

    const previousChannels = channels;
    const fromIndex = previousChannels.findIndex((channel) => channel.id === draggingChannelId);
    const toIndex = previousChannels.findIndex((channel) => channel.id === targetChannelId);

    if (fromIndex < 0 || toIndex < 0) {
      setDraggingChannelId(null);
      return;
    }

    const nextChannels = [...previousChannels];
    const [moved] = nextChannels.splice(fromIndex, 1);
    nextChannels.splice(toIndex, 0, moved);

    setChannels(nextChannels);
    setDraggingChannelId(null);

    try {
      await persistChannelOrder(nextChannels);
      onUpdate();
    } catch (err) {
      setChannels(previousChannels);
      toast(err instanceof Error ? err.message : "排序失败", "error");
    }
  };

  // Copy API key
  const handleCopyApiKey = async (id: string) => {
    setCopyingId(id);
    try {
      const response = await fetch(`/api/channel/${id}/key`, { headers });
      if (!response.ok) throw new Error("获取 API Key 失败");
      const data = await response.json();
      await navigator.clipboard.writeText(data.apiKey);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制失败");
    } finally {
      setCopyingId(null);
    }
  };

  // Export channels
  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/channel/export", { headers });
      if (!response.ok) throw new Error("导出失败");
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `channels-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("导出成功", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "导出失败", "error");
    } finally {
      setExporting(false);
    }
  };

  // Import channels
  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const data = JSON.parse(importText);
      const response = await fetch("/api/channel/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...data, mode: importMode }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "导入失败");
      }
      const result = await response.json();
      setShowImportModal(false);
      setImportText("");
      fetchChannels();
      onUpdate();
      const syncInfo = result.syncedModels > 0 ? `, 同步模型 ${result.syncedModels}` : "";
      toast(`导入成功: 新增 ${result.imported}, 更新 ${result.updated}, 跳过 ${result.skipped}${syncInfo}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "导入失败", "error");
    } finally {
      setImporting(false);
    }
  };

  // Handle file import
  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target?.result as string);
    };
    reader.readAsText(file);
  };

  // 云通知 sync
  const handleWebDAVSync = async (action: "upload" | "download") => {
    if (action === "upload") {
      setWebdavUploading(true);
    } else {
      setWebdavDownloading(true);
    }
    setError(null);

    // Save config to sessionStorage before request (password excluded for security)
    // Note: Password is not persisted - user must re-enter or rely on env variable
    sessionStorage.setItem("webdav-config", JSON.stringify({
      url: webdavConfig.url,
      username: webdavConfig.username,
      filename: webdavConfig.filename,
    }));

    try {
      const response = await fetch("/api/channel/webdav", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          ...webdavConfig,
          mode: webdavMode,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "同步失败");

      if (action === "download") {
        fetchChannels();
        onUpdate();
        const syncInfo = result.syncedModels > 0 ? `, 同步模型 ${result.syncedModels}` : "";
        const dupInfo = result.duplicates > 0 ? `, 重复跳过 ${result.duplicates}` : "";
        toast(`下载成功: 新增 ${result.imported}, 跳过 ${result.skipped}${dupInfo}${syncInfo}`, "success");
      } else {
        const mergeInfo = result.mergedFromRemote > 0 ? `, 合并远端 ${result.mergedFromRemote}` : "";
        toast(`上传成功: 本地 ${result.localCount} 个渠道, 共上传 ${result.totalUploaded} 个${mergeInfo}`, "success");
      }
      setShowWebDAVModal(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "同步失败", "error");
    } finally {
      if (action === "upload") {
        setWebdavUploading(false);
      } else {
        setWebdavDownloading(false);
      }
    }
  };

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      {/* Header - Toggle */}
      <div className="flex items-center gap-2 p-4 overflow-hidden">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center justify-between gap-2 hover:bg-accent/50 px-3 py-2 -ml-3 rounded transition-colors min-w-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Settings className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">渠道管理</span>
            {channels.length > 0 && (
              <span className="text-sm text-muted-foreground shrink-0">
                ({channels.length})
              </span>
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
        </button>

        {/* Action buttons - compact on mobile */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Add channel button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAdd();
            }}
            className="inline-flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            title="添加渠道"
            aria-label="添加渠道"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">添加</span>
          </button>

          {/* Import button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowImportModal(true);
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors"
            title="导入渠道"
            aria-label="导入渠道"
          >
            <Upload className="h-4 w-4" />
          </button>

          {/* Export button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleExport();
            }}
            disabled={exporting}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
            title="导出渠道"
            aria-label="导出渠道"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </button>

          {/* Sync all models button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSyncAllMode(true);
              setFilterFromEdit(false);
              setFilterChannels(channels.map((c) => ({ id: c.id, name: c.name })));
              setShowFilterModal(true);
            }}
            disabled={channels.length === 0}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
            title="全量同步模型"
            aria-label="全量同步模型"
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          {/* 云通知按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowWebDAVModal(true);
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors"
            title="云通知"
            aria-label="云通知"
          >
            <Cloud className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Error */}
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Channel list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              暂无渠道，点击上方按钮添加
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {channels
                  .slice((channelPage - 1) * CHANNELS_PER_PAGE, channelPage * CHANNELS_PER_PAGE)
                  .map((channel) => (
                <div
                  key={channel.id}
                  draggable
                  onDragStart={() => setDraggingChannelId(channel.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDropChannel(channel.id)}
                  onDragEnd={() => setDraggingChannelId(null)}
                  className={cn(
                    "flex flex-col p-3 rounded-md border bg-background",
                    getChannelBorderClass(channel),
                    draggingChannelId === channel.id && "opacity-60"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="font-medium truncate">
                        {channel.name}
                      </span>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {channel.baseUrl}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {channel._count?.models || 0} 个模型
                    {(channel._count?.channelKeys ?? 0) > 0 && (
                      <> | <Key className="inline h-3 w-3" /> {(channel._count?.channelKeys ?? 0) + 1} 个 Key</>
                    )}
                    {channel.keyMode === "multi" && (
                      <> | {channel.routeStrategy === "random" ? "随机" : "轮询"}</>
                    )}
                    {" "}| Key: {channel.apiKey}
                  </div>
                  {/* Sync status message */}
                  {syncStatus[channel.id] && (
                    <div
                      className={cn(
                        "text-xs mt-2 px-2 py-1 rounded",
                        syncStatus[channel.id].type === "success"
                          ? "bg-green-500/10 text-green-600 dark:text-green-400"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {syncStatus[channel.id].message}
                    </div>
                  )}
                  <div className="flex items-center gap-1 mt-3 pt-2 border-t border-border">
                    <button
                      onClick={() => handleCopyApiKey(channel.id)}
                      disabled={copyingId === channel.id}
                      className="p-2 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                      title="复制 API Key"
                      aria-label="复制 API Key"
                    >
                      {copyingId === channel.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : copiedId === channel.id ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    <button
                      onClick={() => {
                        setSyncAllMode(false);
                        setFilterFromEdit(false);
                        setFilterChannels([{ id: channel.id, name: channel.name }]);
                        setShowFilterModal(true);
                      }}
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                      title="同步模型列表"
                      aria-label="同步模型列表"
                    >
                      <RefreshCw className="h-4 w-4 text-blue-500" />
                    </button>
                    <button
                      onClick={() => handleEdit(channel)}
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                      title="编辑"
                      aria-label="编辑渠道"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                    {deleteConfirm === channel.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(channel.id)}
                          className="px-2 py-1 text-xs rounded bg-destructive text-destructive-foreground"
                        >
                          确认
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="px-2 py-1 text-xs rounded bg-muted"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(channel.id)}
                        className="p-2 rounded-md hover:bg-accent transition-colors"
                        title="删除"
                        aria-label="删除渠道"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {channels.length > CHANNELS_PER_PAGE && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => setChannelPage((p) => Math.max(1, p - 1))}
                  disabled={channelPage <= 1}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                    channelPage <= 1
                      ? "text-muted-foreground cursor-not-allowed"
                      : "text-foreground hover:bg-accent"
                  )}
                >
                  <ChevronUp className="h-4 w-4 rotate-[-90deg]" />
                </button>
                <span className="text-sm text-muted-foreground">
                  {channelPage} / {Math.ceil(channels.length / CHANNELS_PER_PAGE)}
                </span>
                <button
                  onClick={() => setChannelPage((p) => Math.min(Math.ceil(channels.length / CHANNELS_PER_PAGE), p + 1))}
                  disabled={channelPage >= Math.ceil(channels.length / CHANNELS_PER_PAGE)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                    channelPage >= Math.ceil(channels.length / CHANNELS_PER_PAGE)
                      ? "text-muted-foreground cursor-not-allowed"
                      : "text-foreground hover:bg-accent"
                  )}
                >
                  <ChevronDown className="h-4 w-4 rotate-[-90deg]" />
                </button>
              </div>
            )}
          </>
          )}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="channel-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="channel-modal-title" className="text-lg font-semibold">
                {editingChannel ? "编辑渠道" : "添加渠道"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal form */}
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  渠道名称 <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="OpenAI"
                  required
                />
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  Base URL <span className="text-destructive">*</span>
                </label>
                <input
                  type="url"
                  value={formData.baseUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, baseUrl: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="https://api.openai.com"
                  required
                />
              </div>

              {/* API Key + View Toggle + Route Strategy (same line) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium">
                    API Key{" "}
                    {!editingChannel && (
                      <span className="text-destructive">*</span>
                    )}
                  </label>
                  <div className="flex items-center gap-3">
                    {/* View toggle (only when editing with existing keys) */}
                    {editingChannel && (channelKeysInfo.length > 0 || maskedApiKey) && (
                      <div className="flex items-center rounded-md border border-input bg-background text-xs overflow-hidden">
                        <button
                          type="button"
                          onClick={async () => {
                            if (keyViewMode === "edit" && editingChannel) {
                              // 切回列表时从服务器重新加载 keys，避免使用临时 ID
                              try {
                                const [keysRes, mainKeyRes] = await Promise.all([
                                  fetch(`/api/channel/${editingChannel.id}/keys`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  }),
                                  fetch(`/api/channel/${editingChannel.id}/key`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  }),
                                ]);
                                if (keysRes.ok) {
                                  const data = await keysRes.json();
                                  setChannelKeysInfo((data.keys || []).map((k: { id: string; maskedKey: string; fullKey: string; lastValid?: boolean | null }) => ({
                                    id: k.id,
                                    maskedKey: k.maskedKey,
                                    fullKey: k.fullKey,
                                    lastValid: k.lastValid ?? null,
                                  })));
                                }
                                if (mainKeyRes.ok) {
                                  const data = await mainKeyRes.json();
                                  if (data.apiKey) {
                                    setMainKeyFull(data.apiKey);
                                    const masked = data.apiKey.length > 12 ? data.apiKey.slice(0, 8) + "..." + data.apiKey.slice(-4) : "***";
                                    setMaskedApiKey(masked);
                                  }
                                }
                              } catch {
                                // 加载失败时不阻塞切换
                              }
                              setValidateResults([]);
                            }
                            setKeyViewMode("list");
                          }}
                          className={cn(
                            "px-2.5 py-1 transition-colors",
                            keyViewMode === "list"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          列表
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // Always replace textarea with current keys
                            const allKeys = [mainKeyFull, ...channelKeysInfo.map((k) => k.fullKey)].filter(Boolean).join("\n");
                            setFormData((prev) => ({ ...prev, multiKeys: allKeys }));
                            setKeyViewMode("edit");
                          }}
                          className={cn(
                            "px-2.5 py-1 transition-colors",
                            keyViewMode === "edit"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          编辑
                        </button>
                      </div>
                    )}
                    {/* Route strategy */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">路由</span>
                      <div className="flex items-center rounded-md border border-input bg-background text-xs overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, routeStrategy: "round_robin" })}
                          className={cn(
                            "px-2 py-1 transition-colors",
                            formData.routeStrategy === "round_robin"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          轮询
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, routeStrategy: "random" })}
                          className={cn(
                            "px-2 py-1 transition-colors",
                            formData.routeStrategy === "random"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          随机
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* List view (editing existing channel) */}
                {editingChannel && keyViewMode === "list" && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      共 {channelKeysInfo.length + (maskedApiKey ? 1 : 0)} 个Key
                    </p>
                    <div className="rounded-md border border-border max-h-48 overflow-y-auto divide-y divide-border">
                      {/* Main key row */}
                      {mainKeyFull && (
                        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-blue-500/5 overflow-hidden">
                          {editingKeyTarget === "main" ? (
                            <>
                              <input
                                type="text"
                                value={editKeyValue}
                                onChange={(e) => setEditKeyValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); handleEditKeySave(); }
                                  if (e.key === "Escape") setEditingKeyTarget(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-0.5 rounded border border-input bg-background text-xs font-mono"
                                autoFocus
                              />
                              <button type="button" onClick={handleEditKeySave} className="shrink-0 p-0.5 rounded hover:text-primary"><Check className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => setEditingKeyTarget(null)} className="shrink-0 p-0.5 rounded hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-mono flex-1 min-w-0 truncate select-all" title={mainKeyFull}>{mainKeyFull}</span>
                              <span className="text-xs text-blue-500 shrink-0">主</span>
                              <button
                                type="button"
                                onClick={() => { setEditingKeyTarget("main"); setEditKeyValue(mainKeyFull); }}
                                className="shrink-0 p-0.5 rounded hover:text-primary transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={handleDeleteMainKey}
                                disabled={deletingMainKey}
                                className="shrink-0 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                                title={channelKeysInfo.length === 0 ? "没有其他 Key 可提升，无法删除" : "删除主 Key，下一个 Key 将提升为主 Key"}
                              >
                                {deletingMainKey ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {/* Extra keys */}
                      {channelKeysInfo.map((k) => (
                        <div
                          key={k.id}
                          className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 overflow-hidden",
                            k.lastValid === true
                              ? "bg-green-500/5"
                              : k.lastValid === false
                                ? "bg-red-500/5"
                                : ""
                          )}
                        >
                          {editingKeyTarget === k.id ? (
                            <>
                              <input
                                type="text"
                                value={editKeyValue}
                                onChange={(e) => setEditKeyValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); handleEditKeySave(); }
                                  if (e.key === "Escape") setEditingKeyTarget(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-0.5 rounded border border-input bg-background text-xs font-mono"
                                autoFocus
                              />
                              <button type="button" onClick={handleEditKeySave} className="shrink-0 p-0.5 rounded hover:text-primary"><Check className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => setEditingKeyTarget(null)} className="shrink-0 p-0.5 rounded hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-mono flex-1 min-w-0 truncate select-all" title={k.fullKey}>{k.fullKey}</span>
                              <span
                                className={cn(
                                  "text-xs shrink-0",
                                  k.lastValid === true
                                    ? "text-green-600 dark:text-green-400"
                                    : k.lastValid === false
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-muted-foreground"
                                )}
                              >
                                {k.lastValid === true ? "有效" : k.lastValid === false ? "无效" : ""}
                              </span>
                              <button
                                type="button"
                                onClick={() => { setEditingKeyTarget(k.id); setEditKeyValue(k.fullKey); }}
                                className="shrink-0 p-0.5 rounded hover:text-primary transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSingleKey(k.id)}
                                disabled={deletingKeyId === k.id}
                                className="shrink-0 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                              >
                                {deletingKeyId === k.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleValidateKeys}
                        disabled={validating}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors"
                      >
                        {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        验证所有Key
                      </button>
                      {channelKeysInfo.some((k) => k.lastValid === false) && (
                        <button
                          type="button"
                          onClick={handleBatchDeleteInvalid}
                          disabled={batchDeleting}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-red-500/50 text-red-600 dark:text-red-400 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                        >
                          {batchDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          删除无效Key
                        </button>
                      )}
                    </div>

                    {/* Add single key */}
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newSingleKey}
                        onChange={(e) => setNewSingleKey(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); handleAddSingleKey(); }
                        }}
                        className="flex-1 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-mono"
                        placeholder="输入新 Key 添加..."
                      />
                      <button
                        type="button"
                        onClick={handleAddSingleKey}
                        disabled={addingSingleKey || !newSingleKey.trim()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {addingSingleKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        添加
                      </button>
                    </div>
                  </div>
                )}

                {/* Edit view (batch textarea) - for editing existing channel when toggled to edit, or always for create */}
                {(!editingChannel || (editingChannel && keyViewMode === "edit")) && (
                  <div className="space-y-2">
                    <textarea
                      value={formData.multiKeys}
                      onChange={(e) =>
                        setFormData({ ...formData, multiKeys: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm font-mono resize-none"
                      style={{ minHeight: "120px", maxHeight: "240px" }}
                      placeholder={editingChannel ? "修改后保存将覆盖所有Key，一行一个" : "一行一个Key，第一个为主Key"}
                    />
                    {editingChannel && (
                      <button
                        type="button"
                        onClick={handleSaveKeysFromTextarea}
                        disabled={savingKeys || !formData.multiKeys.trim()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {savingKeys ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        保存 Key
                      </button>
                    )}
                    {!editingChannel && (
                      <p className="text-xs text-muted-foreground">
                        支持一行一个或逗号分隔，第一个Key为主Key
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Proxy */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  代理地址
                </label>
                <input
                  type="text"
                  value={formData.proxy}
                  onChange={(e) =>
                    setFormData({ ...formData, proxy: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="http://... 或 socks5://...（可选）"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  支持 HTTP/HTTPS/SOCKS5 代理
                </p>
              </div>

              {/* Error in modal */}
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Submit */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingChannel ? "保存" : "添加"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowImportModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="import-modal-title" className="text-lg font-semibold">导入渠道</h2>
              <button
                onClick={() => setShowImportModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Import mode */}
              <div>
                <label className="block text-sm font-medium mb-1">导入模式</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as "merge" | "replace")}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                >
                  <option value="merge">合并（更新同名渠道）</option>
                  <option value="replace">替换（删除所有现有渠道）</option>
                </select>
              </div>

              {/* File input */}
              <div>
                <label className="block text-sm font-medium mb-1">选择文件</label>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileImport}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>

              {/* JSON textarea */}
              <div>
                <label className="block text-sm font-medium mb-1">或粘贴 JSON</label>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono text-sm h-40"
                  placeholder='{"version":"1.0","channels":[...]}'
                />
              </div>

              {/* Error in modal */}
              {error && importing && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Submit */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || !importText.trim()}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                  导入
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 云通知 Modal */}
      {showWebDAVModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="webdav-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowWebDAVModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="webdav-modal-title" className="text-lg font-semibold">云通知</h2>
              <button
                onClick={() => setShowWebDAVModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Env config hint */}
              {webdavEnvConfigured && (
                <div className="p-3 rounded-md bg-green-500/10 border border-green-500/20 text-sm text-green-600 dark:text-green-400">
                  已从环境变量加载云通知配置。密码留空将使用环境变量中的密码。
                </div>
              )}

              {/* Jianguoyun hint */}
              <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 dark:text-blue-400">
                坚果云用户：需先在网页端创建同步文件夹，URL 填写到该文件夹路径。密码需使用应用密码（非登录密码）。
              </div>

              {/* 云服务 URL */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  服务地址 <span className="text-destructive">*</span>
                </label>
                <input
                  type="url"
                  value={webdavConfig.url}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, url: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="https://dav.jianguoyun.com/dav/你的文件夹"
                />
              </div>

              {/* Username */}
              <div>
                <label className="block text-sm font-medium mb-1">用户名</label>
                <input
                  type="text"
                  value={webdavConfig.username}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, username: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="邮箱或用户名"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-medium mb-1">密码</label>
                <input
                  type="password"
                  value={webdavConfig.password}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, password: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder={webdavEnvConfigured ? "留空使用环境变量密码" : "应用密码"}
                />
              </div>

              {/* Filename */}
              <div>
                <label className="block text-sm font-medium mb-1">文件路径</label>
                <input
                  type="text"
                  value={webdavConfig.filename}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, filename: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="channels.json"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  可包含子目录（如 backup/channels.json），子目录会自动创建
                </p>
              </div>

              {/* Sync mode */}
              <div>
                <label className="block text-sm font-medium mb-1">同步模式</label>
                <select
                  value={webdavMode}
                  onChange={(e) => setWebdavMode(e.target.value as "merge" | "replace")}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                >
                  <option value="merge">合并（保留已有渠道，仅添加新渠道）</option>
                  <option value="replace">替换（清空后重新导入）</option>
                </select>
              </div>

              {/* Error in modal */}
              {error && (webdavUploading || webdavDownloading) && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowWebDAVModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => handleWebDAVSync("download")}
                  disabled={webdavUploading || webdavDownloading || !webdavConfig.url}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {webdavDownloading && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Download className="h-4 w-4" />
                  下载
                </button>
                <button
                  onClick={() => handleWebDAVSync("upload")}
                  disabled={webdavUploading || webdavDownloading || !webdavConfig.url}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {webdavUploading && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Upload className="h-4 w-4" />
                  上传
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Model Filter Modal - shown after save or sync */}
      {showFilterModal && filterChannels.length > 0 && (
        <ModelFilterModal
          channels={filterChannels}
          onClose={() => {
            setShowFilterModal(false);
            setFilterChannels([]);
            setSyncAllMode(false);
            setFilterFromEdit(false);
          }}
          onBack={filterFromEdit ? () => {
            setShowFilterModal(false);
            setFilterFromEdit(false);
            setShowModal(true);
          } : undefined}
          onSyncComplete={() => {
            fetchChannels();
            onUpdate();
          }}
        />
      )}
    </div>
  );
}
