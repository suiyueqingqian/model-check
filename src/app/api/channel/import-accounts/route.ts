// Import channels from accounts backup JSON (SSE streaming)
// Fetches API keys from each site using access_token, then creates channels
// Returns progress via Server-Sent Events to avoid timeout

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { syncAllChannelsToWebDAV, isWebDAVConfigured } from "@/lib/webdav/sync";

interface AccountItem {
  site_name: string;
  site_url: string;
  disabled?: boolean;
  account_info?: {
    id?: number;
    access_token: string;
  };
}

interface TokenItem {
  key: string;
  name?: string;
  status?: number;
}

interface TokenResponse {
  success: boolean;
  data?: {
    items?: TokenItem[];  // 格式1: data.items
    data?: TokenItem[];   // 格式2: data.data
  };
}

// 计算 acw_sc__v2 cookie（绕过知道创宇加速乐 WAF）
function calcAcwScV2(arg1: string, key: string): string {
  const m = [0xf, 0x23, 0x1d, 0x18, 0x21, 0x10, 0x1, 0x26, 0xa, 0x9, 0x13, 0x1f, 0x28, 0x1b, 0x16, 0x17, 0x19, 0xd, 0x6, 0xb, 0x27, 0x12, 0x14, 0x8, 0xe, 0x15, 0x20, 0x1a, 0x2, 0x1e, 0x7, 0x4, 0x11, 0x5, 0x3, 0x1c, 0x22, 0x25, 0xc, 0x24];

  // 按 m 顺序重排 arg1
  const q: string[] = [];
  for (let x = 0; x < arg1.length; x++) {
    for (let z = 0; z < m.length; z++) {
      if (m[z] === x + 1) q[z] = arg1[x];
    }
  }
  const u = q.join("");

  // u 与 key 进行 XOR
  let v = "";
  for (let x = 0; x < u.length && x < key.length; x += 2) {
    let A = (parseInt(u.substring(x, x + 2), 16) ^ parseInt(key.substring(x, x + 2), 16)).toString(16);
    if (A.length === 1) A = "0" + A;
    v += A;
  }
  return v;
}

// 从 HTML 中提取 arg1 参数
function extractArg1(html: string): string | null {
  const match = html.match(/var\s+arg1\s*=\s*['"]([A-Fa-f0-9]{40})['"]/);
  return match ? match[1] : null;
}

// 从 HTML 中提取密钥（解码混淆的 JS 数组）
function extractKey(html: string): string | null {
  // 匹配类似 ['xxx', 'yyy', ...] 的数组
  const arrMatch = html.match(/\[([^\]]{500,})\]/);
  if (!arrMatch) return null;

  // 提取数组元素
  const elements = arrMatch[1].match(/'([^']+)'/g);
  if (!elements || elements.length < 35) return null;

  // 解码 base64 变体
  const decode = (str: string): string => {
    const m = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";
    let n = "";
    for (let q = 0, r = 0, s, t = 0; (s = str.charAt(t++)); ~s && (r = q % 4 ? r * 64 + s : s, q++ % 4) ? n += String.fromCharCode(255 & r >> (-2 * q & 6)) : 0) {
      s = m.indexOf(s);
    }
    try {
      return decodeURIComponent(n.split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
    } catch {
      return "";
    }
  };

  // 尝试找到 40 位十六进制的密钥（通常在数组第 34 或 35 个位置附近）
  for (let i = 30; i < Math.min(elements.length, 45); i++) {
    const elem = elements[i].slice(1, -1); // 去掉引号
    const decoded = decode(elem);
    if (/^[0-9a-f]{40}$/i.test(decoded)) {
      return decoded;
    }
  }

  // 备用：直接匹配 40 位十六进制
  const keyMatch = html.match(/['"]([0-9a-f]{40})['"]/i);
  return keyMatch ? keyMatch[1] : null;
}

// Fetch API keys from a site using access_token
async function fetchApiKeys(siteUrl: string, accessToken: string, userId?: number): Promise<{ keys: string[]; error?: string }> {
  const url = `${siteUrl.replace(/\/$/, "")}/api/token/?p=0&size=100`;

  const buildHeaders = (cookie?: string): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (userId) {
      const userIdStr = String(userId);
      h["user-id"] = userIdStr;
      h["new-api-user"] = userIdStr;
      h["neo-api-user"] = userIdStr;
      h["rix-api-user"] = userIdStr;
      h["veloera-user"] = userIdStr;
      h["voapi-user"] = userIdStr;
    }
    if (cookie) {
      h["Cookie"] = cookie;
    }
    return h;
  };

  try {
    let res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { keys: [], error: `HTTP ${res.status}` };
    }

    // 检查是否返回了 HTML（WAF/反爬虫页面）
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      // 尝试提取 arg1 并计算 acw_sc__v2 绕过 WAF
      const html = await res.text();
      const arg1 = extractArg1(html);
      if (!arg1) {
        return { keys: [], error: "需要人机验证" };
      }

      // 提取密钥
      const key = extractKey(html);
      if (!key) {
        return { keys: [], error: "无法解析WAF密钥" };
      }

      // 提取服务端返回的 cookie
      const setCookies = res.headers.getSetCookie?.() || [];
      const cookieParts: string[] = [];
      for (const sc of setCookies) {
        const match = sc.match(/^([^=]+=[^;]+)/);
        if (match) cookieParts.push(match[1]);
      }

      // 计算 acw_sc__v2 并添加到 cookie
      const acwScV2 = calcAcwScV2(arg1, key);
      cookieParts.push(`acw_sc__v2=${acwScV2}`);
      const cookie = cookieParts.join("; ");

      // 带 cookie 重试请求
      res = await fetch(url, {
        headers: buildHeaders(cookie),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { keys: [], error: `HTTP ${res.status}` };
      }

      const retryContentType = res.headers.get("content-type") || "";
      if (retryContentType.includes("text/html")) {
        return { keys: [], error: "WAF 绕过失败" };
      }
    }

    let data: TokenResponse;
    try {
      data = await res.json();
    } catch {
      return { keys: [], error: "响应格式异常" };
    }

    // 兼容两种格式: data.items 或 data.data
    const items = data.data?.items || data.data?.data;
    if (!data.success || !items || items.length === 0) {
      return { keys: [], error: "响应格式异常" };
    }
    // 按 name 去重，同名只取第一个启用的 key
    const seenNames = new Set<string>();
    const keys: string[] = [];
    for (const item of items) {
      if (!item.key?.trim() || item.status !== 1) continue;
      const name = item.name || "";
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      const key = item.key.trim();
      keys.push(key.startsWith("sk-") ? key : `sk-${key}`);
    }
    return { keys };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    return { keys: [], error: msg };
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "无效的 JSON 数据", code: "INVALID_DATA" },
      { status: 400 }
    );
  }

  const data = body as Record<string, unknown>;
  const accountsObj = data?.accounts as Record<string, unknown> | undefined;
  const accounts: AccountItem[] = (accountsObj?.accounts || data?.accounts || []) as AccountItem[];

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "未找到有效的账号数据", code: "INVALID_DATA" },
      { status: 400 }
    );
  }

  // SSE streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      let imported = 0;
      let skipped = 0;
      let merged = 0;
      const errors: { name: string; reason: string; url: string }[] = [];
      const importedChannelIds: string[] = [];

      // Build existing channel maps for duplicate detection
      const existingChannels = await prisma.channel.findMany({
        include: { channelKeys: { select: { apiKey: true } } },
      });
      const existingNameSet = new Set(existingChannels.map((ch) => ch.name));
      // Map baseUrl -> channel info for merging keys
      type ChannelInfo = { id: string; name: string; baseUrl: string; apiKey: string; keyMode: string; channelKeys: { apiKey: string }[] };
      const baseUrlMap = new Map<string, ChannelInfo>();
      for (const ch of existingChannels) {
        baseUrlMap.set(ch.baseUrl, ch);
      }

      const total = accounts.length;
      send("progress", { phase: "import", current: 0, total, name: "开始导入..." });

      // Phase 1: Fetch API keys and create channels
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const { site_name, site_url, account_info } = account;

        send("progress", { phase: "import", current: i + 1, total, name: site_name || "未知" });

        if (!site_name || !site_url || !account_info?.access_token) {
          errors.push({ name: site_name || "未知", reason: "缺少必要字段", url: site_url || "" });
          continue;
        }

        const normalizedBaseUrl = site_url.replace(/\/$/, "");

        const { keys, error: fetchError } = await fetchApiKeys(normalizedBaseUrl, account_info.access_token, account_info.id);

        if (keys.length === 0) {
          errors.push({ name: site_name, reason: fetchError || "未获取到 API Key", url: normalizedBaseUrl });
          continue;
        }

        // Check if baseUrl already exists → merge keys into existing channel
        const existingByUrl = baseUrlMap.get(normalizedBaseUrl);
        if (existingByUrl) {
          try {
            // Collect all existing keys for this channel
            const existingKeySet = new Set<string>();
            existingKeySet.add(existingByUrl.apiKey);
            for (const ck of existingByUrl.channelKeys) {
              existingKeySet.add(ck.apiKey);
            }

            // Find new keys that don't already exist
            const newKeys = keys.filter((k) => !existingKeySet.has(k));
            if (newKeys.length === 0) {
              skipped++;
              continue;
            }

            // Add new keys as channelKeys
            await prisma.channelKey.createMany({
              data: newKeys.map((k) => ({
                channelId: existingByUrl.id,
                apiKey: k,
              })),
            });

            // Switch to multi mode if not already
            if (existingByUrl.keyMode !== "multi") {
              await prisma.channel.update({
                where: { id: existingByUrl.id },
                data: { keyMode: "multi" },
              });
            }

            // Update local cache
            for (const k of newKeys) {
              existingByUrl.channelKeys.push({ apiKey: k });
            }

            importedChannelIds.push(existingByUrl.id);
            merged++;
          } catch (err) {
            errors.push({
              name: site_name,
              reason: err instanceof Error ? err.message : "合并 Key 失败",
              url: normalizedBaseUrl,
            });
          }
          continue;
        }

        // Check name collision (different baseUrl but same name)
        if (existingNameSet.has(site_name)) {
          skipped++;
          continue;
        }

        const mainKey = keys[0];
        const extraKeys = keys.slice(1);
        const keyMode = keys.length > 1 ? "multi" : "single";

        try {
          let finalName = site_name;
          if (existingNameSet.has(finalName)) {
            let suffix = 2;
            while (existingNameSet.has(`${site_name} (${suffix})`)) suffix++;
            finalName = `${site_name} (${suffix})`;
          }

          const channel = await prisma.channel.create({
            data: {
              name: finalName,
              baseUrl: normalizedBaseUrl,
              apiKey: mainKey,
              proxy: null,
              enabled: true,
              keyMode,
              routeStrategy: "round_robin",
            },
          });

          if (extraKeys.length > 0) {
            await prisma.channelKey.createMany({
              data: extraKeys.map((k) => ({
                channelId: channel.id,
                apiKey: k,
              })),
            });
          }

          existingNameSet.add(finalName);
          // Register in baseUrlMap so subsequent same-baseUrl accounts merge into this one
          baseUrlMap.set(normalizedBaseUrl, {
            id: channel.id,
            name: finalName,
            baseUrl: normalizedBaseUrl,
            apiKey: mainKey,
            keyMode,
            channelKeys: extraKeys.map((k) => ({ apiKey: k })),
          });
          importedChannelIds.push(channel.id);
          imported++;
        } catch (err) {
          errors.push({
            name: site_name,
            reason: err instanceof Error ? err.message : "创建渠道失败",
            url: normalizedBaseUrl,
          });
        }
      }

      // 不再自动同步模型，由前端打开模型筛选弹窗让用户选择

      // WebDAV sync (silent)
      if (isWebDAVConfigured() && importedChannelIds.length > 0) {
        try {
          const allChannels = await prisma.channel.findMany({
            select: {
              name: true, baseUrl: true, apiKey: true,
              proxy: true, enabled: true, keyMode: true, routeStrategy: true,
              channelKeys: { select: { apiKey: true, name: true } },
            },
          });
          await syncAllChannelsToWebDAV(allChannels);
        } catch {
          // non-critical
        }
      }

      // 获取导入的渠道名称列表，供前端打开筛选弹窗
      const importedChannels: { id: string; name: string }[] = [];
      if (importedChannelIds.length > 0) {
        const channels = await prisma.channel.findMany({
          where: { id: { in: importedChannelIds } },
          select: { id: true, name: true },
        });
        importedChannels.push(...channels);
      }

      // Final result
      send("done", {
        success: true,
        imported,
        merged,
        skipped,
        total,
        importedChannels,
        errors: errors.length > 0 ? errors : undefined,
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
