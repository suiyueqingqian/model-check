// Worker management API

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { startWorker, stopWorker, isWorkerRunning } from "@/lib/queue/worker";

// GET /api/worker - Get worker status
export async function GET() {
  return NextResponse.json({
    running: isWorkerRunning(),
    timestamp: new Date().toISOString(),
  });
}

// POST /api/worker - Start/stop worker
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const { action } = body;

    if (action === "start") {
      if (isWorkerRunning()) {
        return NextResponse.json({
          success: false,
          message: "Worker is already running",
          running: true,
        });
      }

      startWorker();
      return NextResponse.json({
        success: true,
        message: "Worker started",
        running: true,
      });
    }

    if (action === "stop") {
      if (!isWorkerRunning()) {
        return NextResponse.json({
          success: false,
          message: "Worker is not running",
          running: false,
        });
      }

      await stopWorker();
      return NextResponse.json({
        success: true,
        message: "Worker stopped",
        running: false,
      });
    }

    return NextResponse.json(
      { error: "Invalid action. Use 'start' or 'stop'", code: "INVALID_ACTION" },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to control worker", code: "WORKER_ERROR" },
      { status: 500 }
    );
  }
}
