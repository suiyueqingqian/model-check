// GET /api/sse/progress - Server-Sent Events for detection progress
// Uses shared PubSubManager to avoid creating new Redis connections per SSE client

import { NextRequest } from "next/server";
import { pubsubManager } from "@/lib/redis";
import { PROGRESS_CHANNEL } from "@/lib/queue/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  let isConnected = true;
  let isCleanedUp = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    isConnected = false;

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`)
      );

      try {
        unsubscribe = pubsubManager.subscribe(PROGRESS_CHANNEL, (message) => {
          if (!isConnected) return;

          try {
            const data = JSON.parse(message);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "progress", ...data })}\n\n`)
            );
          } catch {
          }
        });
      } catch {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Failed to subscribe" })}\n\n`)
        );
      }

      heartbeatInterval = setInterval(() => {
        if (isConnected && !isCleanedUp) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "heartbeat", timestamp: Date.now() })}\n\n`)
            );
          } catch {
            cleanup();
          }
        }
      }, 30000);

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
