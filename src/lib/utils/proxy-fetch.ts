// Proxy-enabled fetch utility
// Supports HTTP/HTTPS proxy (via undici) and SOCKS5 proxy (via socks-proxy-agent)

import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import https from "https";
import http from "http";

// Cache proxy agents to avoid creating new ones for each request
const httpProxyAgentCache = new Map<string, ProxyAgent>();
const socksProxyAgentCache = new Map<string, SocksProxyAgent>();

/**
 * Check if a proxy URL is SOCKS5
 */
function isSocksProxy(proxyUrl: string): boolean {
  const lower = proxyUrl.toLowerCase();
  return lower.startsWith("socks5://") || lower.startsWith("socks4://") || lower.startsWith("socks://");
}

/**
 * Get or create a HTTP ProxyAgent for the given proxy URL
 */
function getHttpProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = httpProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    httpProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Get or create a SOCKS ProxyAgent for the given proxy URL
 */
function getSocksProxyAgent(proxyUrl: string): SocksProxyAgent {
  let agent = socksProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new SocksProxyAgent(proxyUrl);
    socksProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Fetch using SOCKS proxy with native Node.js http/https
 */
async function socksFetch(
  url: string | URL,
  options: RequestInit | undefined,
  socksAgent: SocksProxyAgent
): Promise<Response> {
  const urlObj = typeof url === "string" ? new URL(url) : url;
  const isHttps = urlObj.protocol === "https:";
  const httpModule = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: (options?.method as string) || "GET",
      headers: options?.headers as http.OutgoingHttpHeaders,
      agent: socksAgent,
    };

    const req = httpModule.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();

        // Convert Node.js headers to Headers object
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) {
            if (Array.isArray(value)) {
              value.forEach((v) => headers.append(key, v));
            } else {
              headers.set(key, value);
            }
          }
        }

        // Create a Response-like object
        const response = new Response(body, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || "",
          headers,
        });

        resolve(response);
      });
    });

    req.on("error", reject);

    // Handle request body
    if (options?.body) {
      if (typeof options.body === "string") {
        req.write(options.body);
      } else if (Buffer.isBuffer(options.body)) {
        req.write(options.body);
      }
    }

    req.end();
  });
}

/**
 * Fetch with optional proxy support
 * @param url - The URL to fetch
 * @param options - Fetch options (same as native fetch)
 * @param proxy - Optional proxy URL (e.g., "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080")
 * @returns Response object
 */
export async function proxyFetch(
  url: string | URL,
  options?: RequestInit,
  proxy?: string | null
): Promise<Response> {
  if (proxy) {
    if (isSocksProxy(proxy)) {
      // Use SOCKS proxy
      const agent = getSocksProxyAgent(proxy);
      return socksFetch(url, options, agent);
    } else {
      // Use HTTP/HTTPS proxy via undici
      const agent = getHttpProxyAgent(proxy);
      const response = await undiciFetch(url, {
        ...options,
        dispatcher: agent,
      });
      // Convert undici Response to standard Response for compatibility
      return response as unknown as Response;
    }
  }

  // No proxy, use native fetch
  return fetch(url.toString(), options as globalThis.RequestInit);
}

/**
 * Clear proxy agent cache (useful for cleanup or testing)
 */
export function clearProxyAgentCache(): void {
  for (const agent of httpProxyAgentCache.values()) {
    agent.close();
  }
  httpProxyAgentCache.clear();

  // SOCKS agents don't have a close method, just clear the cache
  socksProxyAgentCache.clear();
}
