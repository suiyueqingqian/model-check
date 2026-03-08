// Channel and Model Selector component
// Used for selecting channels and models in scheduler settings and proxy key permissions

"use client";

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Check, Square, CheckSquare, Minus, Search, X, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { getDisplayEndpoints } from "@/lib/utils/model-name";

export interface ModelInfo {
  id: string;
  modelName: string;
  lastStatus: boolean | null;
  detectedEndpoints?: string[];
}

export interface ChannelWithModels {
  id: string;
  name: string;
  models: ModelInfo[];
}

// Endpoint type definitions
type EndpointCategory = "chat" | "cli";

interface EndpointInfo {
  label: string;
  shortLabel: string;
  category: EndpointCategory;
  color: {
    bg: string;
    text: string;
    border: string;
  };
}

const ENDPOINT_CONFIG: Record<string, EndpointInfo> = {
  CHAT: {
    label: "Chat",
    shortLabel: "C",
    category: "chat",
    color: {
      bg: "bg-blue-500/20",
      text: "text-blue-600 dark:text-blue-400",
      border: "border-blue-500/30",
    },
  },
  CLAUDE: {
    label: "Claude",
    shortLabel: "CL",
    category: "cli",
    color: {
      bg: "bg-orange-500/20",
      text: "text-orange-600 dark:text-orange-400",
      border: "border-orange-500/30",
    },
  },
  GEMINI: {
    label: "Gemini",
    shortLabel: "G",
    category: "cli",
    color: {
      bg: "bg-cyan-500/20",
      text: "text-cyan-600 dark:text-cyan-400",
      border: "border-cyan-500/30",
    },
  },
  CODEX: {
    label: "Codex",
    shortLabel: "CX",
    category: "cli",
    color: {
      bg: "bg-violet-500/20",
      text: "text-violet-600 dark:text-violet-400",
      border: "border-violet-500/30",
    },
  },
  IMAGE: {
    label: "Image",
    shortLabel: "I",
    category: "chat",
    color: {
      bg: "bg-pink-500/20",
      text: "text-pink-600 dark:text-pink-400",
      border: "border-pink-500/30",
    },
  },
};

// Get all unique endpoints from channels
function getAllEndpoints(channels: ChannelWithModels[]): string[] {
  const endpoints = new Set<string>();
  channels.forEach((channel) => {
    channel.models.forEach((model) => {
      model.detectedEndpoints?.forEach((ep) => endpoints.add(ep));
    });
  });
  return Array.from(endpoints).sort((a, b) => {
    // Sort by category first (chat before cli), then alphabetically
    const catA = ENDPOINT_CONFIG[a]?.category || "chat";
    const catB = ENDPOINT_CONFIG[b]?.category || "chat";
    if (catA !== catB) return catA === "chat" ? -1 : 1;
    return a.localeCompare(b);
  });
}

// Endpoint badge component
function EndpointBadge({
  endpoint,
  available,
  compact = false,
}: {
  endpoint: string;
  available: boolean;
  compact?: boolean;
}) {
  const config = ENDPOINT_CONFIG[endpoint];
  if (!config) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded border font-medium",
        compact ? "px-1 py-0 text-[10px]" : "px-1.5 py-0.5 text-xs",
        available
          ? cn(config.color.bg, config.color.text, config.color.border)
          : "bg-muted/50 text-muted-foreground/50 border-border/50"
      )}
      title={`${config.label}${available ? " (可用)" : " (不可用)"}`}
    >
      {compact ? config.shortLabel : config.label}
    </span>
  );
}

interface ChannelModelSelectorProps {
  channels: ChannelWithModels[];
  selectedChannelIds: string[];
  selectedModelIds: Record<string, string[]>;
  onSelectionChange: (channelIds: string[], modelIds: Record<string, string[]>) => void;
  selectAllLabel?: string;
  showModelStatus?: boolean;
  showEndpoints?: boolean;
  maxHeight?: string;
  className?: string;
}

export function ChannelModelSelector({
  channels,
  selectedChannelIds,
  selectedModelIds,
  onSelectionChange,
  selectAllLabel = "全部渠道",
  showModelStatus = true,
  showEndpoints = true,
  maxHeight = "16rem",
  className,
}: ChannelModelSelectorProps) {
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<string | null>(null);

  // Get all available endpoints from data
  const availableEndpoints = useMemo(() => getAllEndpoints(channels), [channels]);

  // Check if model supports endpoint and is available
  const isModelAvailableForEndpoint = (model: ModelInfo, endpoint: string): boolean => {
    if (!model.detectedEndpoints?.includes(endpoint)) return false;
    // Model must be available (lastStatus === true)
    return model.lastStatus === true;
  };

  // Filter channels and models based on search query and endpoint filter
  const filteredChannels = useMemo(() => {
    let result = channels;

    // Apply endpoint filter first (requires available models with that endpoint)
    if (endpointFilter) {
      result = result
        .map((channel) => {
          const matchingModels = channel.models.filter((model) =>
            isModelAvailableForEndpoint(model, endpointFilter)
          );
          if (matchingModels.length > 0) {
            return { ...channel, models: matchingModels };
          }
          return null;
        })
        .filter((c): c is ChannelWithModels => c !== null);
    }

    // Then apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result
        .map((channel) => {
          const matchingModels = channel.models.filter((model) =>
            model.modelName.toLowerCase().includes(query)
          );
          if (matchingModels.length > 0 || channel.name.toLowerCase().includes(query)) {
            return {
              ...channel,
              models: matchingModels.length > 0 ? matchingModels : channel.models,
            };
          }
          return null;
        })
        .filter((c): c is ChannelWithModels => c !== null);
    }

    return result;
  }, [channels, searchQuery, endpointFilter]);

  // Get all filtered model IDs for filtered select all
  const filteredModelInfo = useMemo(() => {
    const modelIds: { channelId: string; modelId: string }[] = [];
    filteredChannels.forEach((channel) => {
      channel.models.forEach((model) => {
        modelIds.push({ channelId: channel.id, modelId: model.id });
      });
    });
    return modelIds;
  }, [filteredChannels]);

  // Count total selected models
  const totalSelectedModels = useMemo(() => {
    return Object.values(selectedModelIds).reduce((sum, ids) => sum + ids.length, 0);
  }, [selectedModelIds]);

  // Count total models
  const totalModels = useMemo(() => {
    return channels.reduce((sum, c) => sum + c.models.length, 0);
  }, [channels]);

  // Check if all filtered channels are fully selected (all filtered models in each channel)
  const allFilteredSelected = useMemo(() => {
    if (filteredModelInfo.length === 0) return false;
    return filteredModelInfo.every(({ channelId, modelId }) => {
      const selected = selectedModelIds[channelId] || [];
      return selected.includes(modelId);
    });
  }, [filteredModelInfo, selectedModelIds]);

  // Check if some (but not all) filtered channels/models are selected
  const someFilteredSelected = useMemo(() => {
    if (filteredModelInfo.length === 0) return false;
    const hasAnySelection = filteredModelInfo.some(({ channelId, modelId }) => {
      const selected = selectedModelIds[channelId] || [];
      return selected.includes(modelId);
    });
    return hasAnySelection && !allFilteredSelected;
  }, [filteredModelInfo, selectedModelIds, allFilteredSelected]);

  // Check if all models in a channel are selected
  const isChannelFullySelected = (channelId: string) => {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel || channel.models.length === 0) return false;

    const selected = selectedModelIds[channelId] || [];
    return selected.length === channel.models.length;
  };

  // Check if some models in a channel are selected
  const isChannelPartiallySelected = (channelId: string) => {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel || channel.models.length === 0) return false;

    const selected = selectedModelIds[channelId] || [];
    return selected.length > 0 && selected.length < channel.models.length;
  };

  // Toggle channel expansion
  const toggleChannelExpand = (channelId: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  };

  // Select/deselect all filtered channels/models
  const handleSelectAll = () => {
    if (allFilteredSelected) {
      // Deselect all filtered models
      const newModelIds = { ...selectedModelIds };
      const affectedChannels = new Set<string>();

      filteredModelInfo.forEach(({ channelId, modelId }) => {
        if (newModelIds[channelId]) {
          newModelIds[channelId] = newModelIds[channelId].filter((id) => id !== modelId);
          affectedChannels.add(channelId);
        }
      });

      // Remove empty channel entries and update channel selection
      const newChannelIds = selectedChannelIds.filter((channelId) => {
        const remaining = newModelIds[channelId] || [];
        if (remaining.length === 0) {
          delete newModelIds[channelId];
          return false;
        }
        return true;
      });

      onSelectionChange(newChannelIds, newModelIds);
    } else {
      // Select all filtered channels and their filtered models
      const newModelIds = { ...selectedModelIds };
      const newChannelIds = new Set(selectedChannelIds);

      filteredModelInfo.forEach(({ channelId, modelId }) => {
        if (!newModelIds[channelId]) {
          newModelIds[channelId] = [];
        }
        if (!newModelIds[channelId].includes(modelId)) {
          newModelIds[channelId].push(modelId);
        }
        newChannelIds.add(channelId);
      });

      onSelectionChange(Array.from(newChannelIds), newModelIds);
    }
  };

  // Select/deselect a channel (operates on visible models only when filter is active)
  const handleChannelToggle = (channelId: string) => {
    const hasFilter = searchQuery.trim() !== "" || endpointFilter !== null;
    const channel = hasFilter
      ? filteredChannels.find((c) => c.id === channelId)
      : channels.find((c) => c.id === channelId);
    if (!channel) return;

    const visibleModelIds = channel.models.map((m) => m.id);
    const currentSelected = selectedModelIds[channelId] || [];
    const allVisibleSelected = visibleModelIds.every((id) => currentSelected.includes(id));

    if (allVisibleSelected) {
      // Deselect only visible models, keep hidden ones
      const remaining = currentSelected.filter((id) => !visibleModelIds.includes(id));
      if (remaining.length === 0) {
        onSelectionChange(
          selectedChannelIds.filter((id) => id !== channelId),
          Object.fromEntries(
            Object.entries(selectedModelIds).filter(([id]) => id !== channelId)
          )
        );
      } else {
        onSelectionChange(selectedChannelIds, {
          ...selectedModelIds,
          [channelId]: remaining,
        });
      }
    } else {
      // Select all visible models (merge with existing)
      const merged = [...new Set([...currentSelected, ...visibleModelIds])];
      onSelectionChange(
        selectedChannelIds.includes(channelId) ? selectedChannelIds : [...selectedChannelIds, channelId],
        { ...selectedModelIds, [channelId]: merged }
      );
    }
  };

  // Select/deselect a model
  const handleModelToggle = (channelId: string, modelId: string) => {
    const currentSelected = selectedModelIds[channelId] || [];
    const isSelected = currentSelected.includes(modelId);
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) return;

    let newModelIds: string[];
    if (isSelected) {
      newModelIds = currentSelected.filter((id) => id !== modelId);
    } else {
      newModelIds = [...currentSelected, modelId];
    }

    // Update channel selection based on model selection
    let newChannelIds = [...selectedChannelIds];
    if (newModelIds.length === 0) {
      // No models selected, remove channel from selection
      newChannelIds = newChannelIds.filter((id) => id !== channelId);
    } else if (!newChannelIds.includes(channelId)) {
      // Some models selected, add channel to selection
      newChannelIds.push(channelId);
    }

    onSelectionChange(newChannelIds, {
      ...selectedModelIds,
      [channelId]: newModelIds,
    });
  };

  // Invert selection
  const handleInvertSelection = () => {
    const newChannelIds: string[] = [];
    const newModelIds: Record<string, string[]> = {};

    channels.forEach((channel) => {
      const currentSelected = selectedModelIds[channel.id] || [];
      const invertedModels = channel.models
        .filter((m) => !currentSelected.includes(m.id))
        .map((m) => m.id);

      if (invertedModels.length > 0) {
        newChannelIds.push(channel.id);
        newModelIds[channel.id] = invertedModels;
      }
    });

    onSelectionChange(newChannelIds, newModelIds);
  };

  // Get grouped endpoints for model display
  const getModelEndpoints = (model: ModelInfo): { chat: string[]; cli: string[] } => {
    const chat: string[] = [];
    const cli: string[] = [];

    const endpoints = getDisplayEndpoints(model.modelName, model.detectedEndpoints || []);
    endpoints.forEach((ep) => {
      const config = ENDPOINT_CONFIG[ep];
      if (config) {
        if (config.category === "chat") chat.push(ep);
        else cli.push(ep);
      }
    });

    return { chat, cli };
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索模型名称..."
          className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-accent rounded"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Endpoint filter */}
      {showEndpoints && availableEndpoints.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">端点:</span>
          <button
            type="button"
            onClick={() => setEndpointFilter(null)}
            className={cn(
              "px-2 py-0.5 text-xs rounded border transition-colors",
              endpointFilter === null
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
            )}
          >
            全部
          </button>
          {availableEndpoints.map((ep) => {
            const config = ENDPOINT_CONFIG[ep];
            if (!config) return null;
            const isActive = endpointFilter === ep;
            return (
              <button
                key={ep}
                type="button"
                onClick={() => setEndpointFilter(isActive ? null : ep)}
                className={cn(
                  "px-2 py-0.5 text-xs rounded border transition-colors",
                  isActive
                    ? cn(config.color.bg, config.color.text, config.color.border)
                    : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                )}
              >
                {config.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Control buttons */}
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <button
          type="button"
          onClick={handleSelectAll}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-accent transition-colors"
          title={searchQuery || endpointFilter ? "全选筛选结果" : "全选所有"}
        >
          {allFilteredSelected ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : someFilteredSelected ? (
            <Minus className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span>{searchQuery || endpointFilter ? "全选筛选" : selectAllLabel}</span>
        </button>
        <button
          type="button"
          onClick={handleInvertSelection}
          className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        >
          反选
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            已选 <span className="font-medium text-foreground">{totalSelectedModels}</span>/{totalModels} 模型
          </span>
          {(searchQuery || endpointFilter) && (
            <span className="text-primary">
              (筛选: {filteredModelInfo.length})
            </span>
          )}
        </div>
      </div>

      {/* Channel list */}
      <div className="overflow-y-auto space-y-1" style={{ maxHeight }}>
        {filteredChannels.length === 0 ? (
          <div className="text-center py-4 text-sm text-muted-foreground">
            {searchQuery || endpointFilter ? "没有匹配的模型" : "暂无数据"}
          </div>
        ) : (
          filteredChannels.map((channel) => {
            // When searching or filtering, auto-expand channels
            const isExpanded = expandedChannels.has(channel.id) || searchQuery.trim() !== "" || endpointFilter !== null;
            const isPartial = isChannelPartiallySelected(channel.id);
            const isFull = isChannelFullySelected(channel.id);

          return (
            <div key={channel.id} className="border border-border rounded">
              {/* Channel header - entire row is clickable for expand/collapse */}
              <div
                className="flex items-center gap-1 p-2 hover:bg-accent/50 cursor-pointer"
                onClick={() => toggleChannelExpand(channel.id)}
              >
                <div className="p-0.5">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleChannelToggle(channel.id);
                  }}
                  className="flex items-center gap-2 flex-1 text-left"
                >
                  {isFull ? (
                    <CheckSquare className="h-4 w-4 text-primary" />
                  ) : isPartial ? (
                    <Minus className="h-4 w-4 text-primary" />
                  ) : (
                    <Square className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium">{channel.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ({(selectedModelIds[channel.id] || []).length}/{channel.models.length})
                  </span>
                </button>
              </div>

              {/* Model list */}
              {isExpanded && channel.models.length > 0 && (
                <div className="border-t border-border px-2 py-1 space-y-0.5 bg-muted/30">
                  {channel.models.map((model) => {
                    const isModelSelected = (selectedModelIds[channel.id] || []).includes(model.id);
                    const endpoints = getModelEndpoints(model);

                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => handleModelToggle(channel.id, model.id)}
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-accent rounded text-sm"
                      >
                        {isModelSelected ? (
                          <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                        ) : (
                          <div className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate flex-1 min-w-0">{model.modelName}</span>
                        {/* Endpoint badges */}
                        {showEndpoints && (endpoints.chat.length > 0 || endpoints.cli.length > 0) && (
                          <div className="flex items-center gap-1 shrink-0">
                            {/* Chat endpoints */}
                            {endpoints.chat.map((ep) => (
                              <EndpointBadge
                                key={ep}
                                endpoint={ep}
                                available={model.detectedEndpoints?.includes(ep) === true}
                                compact
                              />
                            ))}
                            {/* CLI endpoints with separator */}
                            {endpoints.cli.length > 0 && endpoints.chat.length > 0 && (
                              <span className="w-px h-3 bg-border mx-0.5" />
                            )}
                            {endpoints.cli.map((ep) => (
                              <EndpointBadge
                                key={ep}
                                endpoint={ep}
                                available={model.detectedEndpoints?.includes(ep) === true}
                                compact
                              />
                            ))}
                          </div>
                        )}
                        {/* Status indicator */}
                        {showModelStatus && (
                          <span
                            className={cn(
                              "w-2 h-2 rounded-full shrink-0",
                              model.lastStatus === true && "bg-green-500",
                              model.lastStatus === false && "bg-red-500",
                              model.lastStatus === null && "bg-gray-400"
                            )}
                            title={
                              model.lastStatus === true
                                ? "正常"
                                : model.lastStatus === false
                                ? "异常"
                                : "未检测"
                            }
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
        )}
      </div>
    </div>
  );
}
