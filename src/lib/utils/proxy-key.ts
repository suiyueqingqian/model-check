// Proxy API Key management
// Auto-generates a random key if not configured in environment

import { randomBytes } from "crypto";

// Environment variable key
const ENV_PROXY_API_KEY = process.env.PROXY_API_KEY;

// Auto-generated key (persists for the lifetime of the process)
let generatedKey: string | null = null;

/**
 * Generate a random API key in sk-xxx format
 */
function generateApiKey(): string {
  // Generate 32 random bytes and convert to base64, then clean up
  const randomPart = randomBytes(32)
    .toString("base64")
    .replace(/[+/=]/g, "") // Remove non-URL-safe characters
    .substring(0, 48); // Take first 48 chars
  return `sk-${randomPart}`;
}

/**
 * Get the proxy API key
 * - If PROXY_API_KEY env is set, use it
 * - Otherwise, auto-generate one (persists for process lifetime)
 */
export function getProxyApiKey(): string {
  if (ENV_PROXY_API_KEY) {
    return ENV_PROXY_API_KEY;
  }

  if (!generatedKey) {
    generatedKey = generateApiKey();
    console.log(`[Proxy] Auto-generated API key: ${generatedKey}`);
  }

  return generatedKey;
}

/**
 * Check if the key was auto-generated or from environment
 */
export function isKeyFromEnvironment(): boolean {
  return !!ENV_PROXY_API_KEY;
}
