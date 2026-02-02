// GET /api/proxy-key - Get proxy API key (admin only)

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { getProxyApiKey, isKeyFromEnvironment } from "@/lib/utils/proxy-key";

export async function GET(request: NextRequest) {
  // Verify admin authentication
  const authError = requireAuth(request);
  if (authError) return authError;

  const key = getProxyApiKey();
  const fromEnv = isKeyFromEnvironment();

  return NextResponse.json({
    key,
    source: fromEnv ? "environment" : "auto-generated",
    message: fromEnv
      ? "代理密钥来自环境变量 PROXY_API_KEY"
      : "代理密钥已自动生成（重启后会变化，建议设置 PROXY_API_KEY 环境变量）",
  });
}
