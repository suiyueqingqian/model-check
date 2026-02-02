// Proxy-enabled fetch utility using undici
// Supports HTTP/HTTPS proxy for outgoing requests

import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";

// Cache proxy agents to avoid creating new ones for each request
const proxyAgentCache = new Map<string, ProxyAgent>();

/**
 * Get or create a ProxyAgent for the given proxy URL
 */
function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Fetch with optional proxy support
 * @param url - The URL to fetch
 * @param options - Fetch options (same as native fetch)
 * @param proxy - Optional proxy URL (e.g., "http://127.0.0.1:7890")
 * @returns Response object
 */
export async function proxyFetch(
  url: string | URL,
  options?: RequestInit,
  proxy?: string | null
): Promise<Response> {
  if (proxy) {
    const agent = getProxyAgent(proxy);
    const response = await undiciFetch(url, {
      ...options,
      dispatcher: agent,
    });
    // Convert undici Response to standard Response for compatibility
    return response as unknown as Response;
  }

  // No proxy, use native fetch
  return fetch(url.toString(), options as globalThis.RequestInit);
}

/**
 * Clear proxy agent cache (useful for cleanup or testing)
 */
export function clearProxyAgentCache(): void {
  for (const agent of proxyAgentCache.values()) {
    agent.close();
  }
  proxyAgentCache.clear();
}
