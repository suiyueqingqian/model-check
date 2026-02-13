// Channel models API - Sync models from /v1/models endpoint

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";

type SelectedModelPair = {
  modelName: string;
  keyId: string | null;
};

// POST /api/channel/[id]/sync - Sync models from channel
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    // Parse optional selectedModels from body
    let selectedModels: string[] | undefined;
    let selectedModelPairs: SelectedModelPair[] | undefined;
    try {
      const body = await request.json();
      if (Array.isArray(body.selectedModels)) {
        selectedModels = body.selectedModels;
      }
      if (Array.isArray(body.selectedModelPairs)) {
        selectedModelPairs = body.selectedModelPairs
          .filter(
            (item: unknown): item is { modelName: unknown; keyId?: unknown } =>
              typeof item === "object" && item !== null && "modelName" in item
          )
          .map((item: { modelName: unknown; keyId?: unknown }) => ({
            modelName: typeof item.modelName === "string" ? item.modelName : "",
            keyId: typeof item.keyId === "string" ? item.keyId : null,
          }))
          .filter((item: { modelName: string; keyId: string | null }) => item.modelName.trim().length > 0);
      }
    } catch {
      // No body or invalid JSON, use default behavior (fetch from API)
    }

    const result = await syncChannelModels(id, selectedModels, selectedModelPairs);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync models";
    return NextResponse.json(
      { error: message, code: "SYNC_ERROR" },
      { status: 500 }
    );
  }
}
