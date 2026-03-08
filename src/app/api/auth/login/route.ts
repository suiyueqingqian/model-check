// POST /api/auth/login - Admin login

import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/auth";

export async function POST(request: NextRequest) {
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
