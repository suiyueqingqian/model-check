// POST /api/auth/login - Admin login

import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/auth";

// 简单的内存限流：IP -> { count, resetAt }
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 分钟
const MAX_MAP_SIZE = 10000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();

  // 惰性清理过期条目，防止 Map 无限增长
  if (loginAttempts.size > MAX_MAP_SIZE) {
    for (const [key, val] of loginAttempts) {
      if (now > val.resetAt) loginAttempts.delete(key);
    }
  }

  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  record.count++;
  return record.count <= MAX_ATTEMPTS;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Too many login attempts, please try again later", code: "RATE_LIMITED" },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Password is required", code: "MISSING_PASSWORD" },
        { status: 400 }
      );
    }

    const token = await authenticateAdmin(password);

    if (!token) {
      return NextResponse.json(
        { error: "Invalid password", code: "INVALID_PASSWORD" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      success: true,
      token,
      expiresIn: "7d",
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error", code: "SERVER_ERROR" },
      { status: 500 }
    );
  }
}
