// GET /v1/models - Return all models from all enabled channels

import { NextRequest, NextResponse } from "next/server";
import { getAllModelsWithChannels, errorResponse, verifyProxyKey } from "@/lib/proxy";

export async function GET(request: NextRequest) {
  // Verify proxy API key
  const authError = verifyProxyKey(request);
  if (authError) return authError;

  try {
    // Get all models from database with channel info
    const models = await getAllModelsWithChannels();

    // Transform to OpenAI-compatible format with channel info
    const data = {
      object: "list",
      data: models.map((m) => ({
        id: m.modelName,
        object: "model",
        created: 0,
        owned_by: m.channelName,
        // Extra field for channel identification
        channel: m.channelName,
      })),
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error("[Proxy /v1/models] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Failed to fetch models: ${message}`, 500);
  }
}
