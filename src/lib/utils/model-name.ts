const GPT_VERSION_REGEX = /gpt-?(\d+(?:\.\d+)?)/i;

export type OpenAIProxyEndpoint = "CHAT" | "CODEX";
export type ModelFamily = "CLAUDE" | "GEMINI" | "CODEX" | "GPT" | "GROK" | "QWEN" | "DEEPSEEK" | "GLM" | "OTHER";

export function getLastSegmentModelName(modelName: string): string {
  const slashIndex = modelName.lastIndexOf("/");
  return slashIndex >= 0 ? modelName.slice(slashIndex + 1) : modelName;
}

function getNormalizedModelName(modelName: string): string {
  const slashIndex = modelName.indexOf("/");
  const actualModelName = slashIndex > 0 ? modelName.slice(slashIndex + 1) : modelName;
  return actualModelName.toLowerCase();
}

export function getModelFamily(modelName: string): ModelFamily {
  const normalizedModelName = getNormalizedModelName(modelName);

  if (normalizedModelName.includes("claude")) {
    return "CLAUDE";
  }

  if (normalizedModelName.includes("gemini")) {
    return "GEMINI";
  }

  if (normalizedModelName.includes("codex")) {
    return "CODEX";
  }

  if (normalizedModelName.includes("grok")) {
    return "GROK";
  }

  if (
    normalizedModelName.includes("deepseek") ||
    normalizedModelName.startsWith("ds-")
  ) {
    return "DEEPSEEK";
  }

  if (
    normalizedModelName.startsWith("qwen") ||
    normalizedModelName.startsWith("qwq") ||
    normalizedModelName.startsWith("qvq")
  ) {
    return "QWEN";
  }

  if (
    normalizedModelName.includes("chatglm") ||
    normalizedModelName.startsWith("glm")
  ) {
    return "GLM";
  }

  if (
    normalizedModelName.startsWith("gpt") ||
    normalizedModelName.startsWith("o1") ||
    normalizedModelName.startsWith("o3") ||
    normalizedModelName.startsWith("o4")
  ) {
    return "GPT";
  }

  return "OTHER";
}

export function isCodexNamedModel(modelName: string): boolean {
  return getModelFamily(modelName) === "CODEX";
}

export function shouldPreferChatCompletionsForModel(modelName: string): boolean {
  const family = getModelFamily(modelName);

  if (family === "CLAUDE" || family === "GEMINI" || family === "CODEX") {
    return false;
  }

  if (family === "GROK" || family === "QWEN") {
    return false;
  }

  if (family === "GPT") {
    return !isGptFiveOrNewerModel(modelName);
  }

  return true;
}

export function getGptVersion(modelName: string): number | null {
  const match = getNormalizedModelName(modelName).match(GPT_VERSION_REGEX);
  if (!match) {
    return null;
  }

  const version = Number(match[1]);
  if (!Number.isFinite(version)) {
    return null;
  }

  return version;
}

export function isGptFiveOrNewerModel(modelName: string): boolean {
  const version = getGptVersion(modelName);
  return version !== null && version >= 5;
}

export function isResponsesCompatibleChatModel(modelName: string): boolean {
  const family = getModelFamily(modelName);

  return family === "GROK" ||
    family === "QWEN" ||
    (family === "GPT" && isGptFiveOrNewerModel(modelName));
}

export function shouldTryResponsesFallbackForChatModel(modelName: string): boolean {
  return isResponsesCompatibleChatModel(modelName);
}

export function shouldUseResponsesOnlyForChatModel(modelName: string): boolean {
  return getModelFamily(modelName) === "CODEX";
}

export function shouldTryChatFallbackForResponsesModel(modelName: string): boolean {
  const family = getModelFamily(modelName);
  return family !== "CLAUDE" && family !== "GEMINI" && family !== "CODEX";
}

export function supportsOpenAIEndpointFallback(modelName: string): boolean {
  const family = getModelFamily(modelName);
  return family !== "CLAUDE" && family !== "GEMINI";
}

function getDetectedOpenAIEndpoints(detectedEndpoints: string[]): OpenAIProxyEndpoint[] {
  const endpoints = detectedEndpoints.filter(
    (endpoint): endpoint is OpenAIProxyEndpoint =>
      endpoint === "CHAT" || endpoint === "CODEX"
  );

  return Array.from(new Set(endpoints));
}

export function getOpenAIEndpointOrder(options: {
  modelName: string;
  requestedEndpoint: OpenAIProxyEndpoint;
  detectedEndpoints?: string[];
  preferredEndpoint?: OpenAIProxyEndpoint | null;
  allowFallback: boolean;
  forceRequestedFirst?: boolean;
}): OpenAIProxyEndpoint[] {
  const {
    modelName,
    requestedEndpoint,
    detectedEndpoints = [],
    preferredEndpoint,
    allowFallback,
    forceRequestedFirst = false,
  } = options;

  if (!allowFallback) {
    return [requestedEndpoint];
  }

  const alternateEndpoint: OpenAIProxyEndpoint =
    requestedEndpoint === "CHAT" ? "CODEX" : "CHAT";

  const availableEndpoints = getDetectedOpenAIEndpoints(detectedEndpoints);
  if (availableEndpoints.length > 0) {
    const hasRequestedEndpoint = availableEndpoints.includes(requestedEndpoint);
    const hasAlternateEndpoint = availableEndpoints.includes(alternateEndpoint);

    if (forceRequestedFirst && hasRequestedEndpoint) {
      return hasAlternateEndpoint
        ? [requestedEndpoint, alternateEndpoint]
        : [requestedEndpoint];
    }

    if (hasRequestedEndpoint && hasAlternateEndpoint) {
      if (preferredEndpoint === alternateEndpoint) {
        return [alternateEndpoint, requestedEndpoint];
      }
      return [requestedEndpoint, alternateEndpoint];
    }

    if (hasRequestedEndpoint) {
      return [requestedEndpoint];
    }

    if (hasAlternateEndpoint) {
      return [alternateEndpoint];
    }

    return [];
  }

  if (forceRequestedFirst) {
    return [requestedEndpoint, alternateEndpoint];
  }

  if (shouldPreferChatCompletionsForModel(modelName)) {
    return ["CHAT", "CODEX"];
  }

  if (preferredEndpoint === alternateEndpoint) {
    return [alternateEndpoint, requestedEndpoint];
  }

  return [requestedEndpoint, alternateEndpoint];
}

export function getDisplayEndpoints(modelName: string, endpoints: string[] = []): string[] {
  const merged = new Set(endpoints);

  if (isCodexNamedModel(modelName)) {
    const codexOnly = merged.has("CODEX") || merged.has("CHAT")
      ? ["CODEX"]
      : [];
    return codexOnly;
  }

  if (isResponsesCompatibleChatModel(modelName) && (merged.has("CHAT") || merged.has("CODEX"))) {
    merged.add("CHAT");
    merged.add("CODEX");
  }

  const order = ["CHAT", "IMAGE", "CLAUDE", "GEMINI", "CODEX"];
  return Array.from(merged).sort((a, b) => {
    const indexA = order.indexOf(a);
    const indexB = order.indexOf(b);
    const safeIndexA = indexA === -1 ? order.length : indexA;
    const safeIndexB = indexB === -1 ? order.length : indexB;
    if (safeIndexA !== safeIndexB) {
      return safeIndexA - safeIndexB;
    }
    return a.localeCompare(b);
  });
}

export function supportsDisplayEndpoint(
  modelName: string,
  endpoints: string[] = [],
  endpoint: string
): boolean {
  return getDisplayEndpoints(modelName, endpoints).includes(endpoint);
}
