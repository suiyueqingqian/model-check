// GET /api/sse/progress - Server-Sent Events for detection progress
// Uses direct Redis subscription for reliability

import { NextRequest } from "next/server";
import Redis from "ioredis";
import { PROGRESS_CHANNEL } from "@/lib/queue/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  let isConnected = true;
  let isCleanedUp = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let subscriber: Redis | null = null;

  // Unified cleanup function to prevent double cleanup
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    isConnected = false;

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (subscriber) {
      subscriber.unsubscribe().catch(() => {});
      subscriber.quit().catch(() => {});
      subscriber = null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`)
      );

      try {
        // Create dedicated Redis connection for this SSE client
        const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
        subscriber = new Redis(redisUrl, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });

        subscriber.on("error", () => {
        });

        // Handle messages
        subscriber.on("message", (channel, message) => {
          if (!isConnected || channel !== PROGRESS_CHANNEL) return;

          try {
            const data = JSON.parse(message);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "progress", ...data })}\n\n`)
            );
          } catch {
          }
        });

        // Subscribe to progress channel
        await subscriber.subscribe(PROGRESS_CHANNEL);

      } catch {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Failed to connect to Redis" })}\n\n`)
        );
      }

      // Keep connection alive with heartbeat
      heartbeatInterval = setInterval(() => {
        if (isConnected && !isCleanedUp) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "heartbeat", timestamp: Date.now() })}\n\n`)
            );
          } catch {
            // Controller might be closed, trigger cleanup
            cleanup();
          }
        }
      }, 30000); // Every 30 seconds

      // Cleanup on abort
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
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
