// Channel API Key endpoint - Get full API key for copying

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

// GET /api/channel/[id]/key - Get full API key (authenticated admin only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { apiKey: true },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "Channel not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    return NextResponse.json({ apiKey: channel.apiKey });
  } catch {
    return NextResponse.json(
      { error: "Failed to get API key", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
