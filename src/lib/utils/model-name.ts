const GPT_VERSION_REGEX = /gpt-?(\d+(?:\.\d+)?)/i;

export type OpenAIProxyEndpoint = "CHAT" | "CODEX";

export function isCodexNamedModel(modelName: string): boolean {
  return modelName.toLowerCase().includes("codex");
}

export function getGptVersion(modelName: string): number | null {
  const match = modelName.toLowerCase().match(GPT_VERSION_REGEX);
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
  return isGptFiveOrNewerModel(modelName) && !isCodexNamedModel(modelName);
}

export function shouldTryResponsesFallbackForChatModel(modelName: string): boolean {
  return isGptFiveOrNewerModel(modelName);
}

export function shouldUseResponsesOnlyForChatModel(modelName: string): boolean {
  return isCodexNamedModel(modelName);
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

  if (isCodexNamedModel(modelName)) {
    return ["CODEX"];
  }

  if (!allowFallback) {
    return [requestedEndpoint];
  }

  const alternateEndpoint: OpenAIProxyEndpoint =
    requestedEndpoint === "CHAT" ? "CODEX" : "CHAT";

  if (forceRequestedFirst) {
    return [requestedEndpoint, alternateEndpoint];
  }

  const availableEndpoints = new Set(
    detectedEndpoints.filter(
      (endpoint): endpoint is OpenAIProxyEndpoint =>
        endpoint === "CHAT" || endpoint === "CODEX"
    )
  );

  if (
    availableEndpoints.has("CHAT") &&
    availableEndpoints.has("CODEX")
  ) {
    return [requestedEndpoint, alternateEndpoint];
  }

  if (availableEndpoints.has(requestedEndpoint)) {
    return [requestedEndpoint, alternateEndpoint];
  }

  if (availableEndpoints.has(alternateEndpoint)) {
    return [alternateEndpoint, requestedEndpoint];
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
