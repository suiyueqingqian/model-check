// GET /v1/models - Return all models from all enabled channels

import { NextRequest, NextResponse } from "next/server";
import {
  getAllModelsWithChannelsUnified,
  verifyProxyKeyAsync,
  errorResponse,
} from "@/lib/proxy";

export async function GET(request: NextRequest) {
  // Verify proxy API key (async for multi-key support)
  const { error: authError, keyResult } = await verifyProxyKeyAsync(request);
  if (authError) return authError;

  try {
    // Get all models from database with channel info, filtered by key permissions
    const models = await getAllModelsWithChannelsUnified(keyResult);
    const isUnifiedMode = keyResult?.keyRecord?.unifiedMode === true;

    // Transform to OpenAI-compatible format with channel prefix for grouping
    const data = {
      object: "list",
      data: models.map((m) => ({
        id: isUnifiedMode ? m.modelName : `${m.channelName}/${m.modelName}`,
        object: "model",
        created: 0,
        owned_by: m.channelName || "unified",
      })),
    };

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Failed to fetch models: ${message}`, 500);
  }
}
