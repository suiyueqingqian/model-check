// GET /api/status - Public system status endpoint

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getQueueStats, isQueueRunning } from "@/lib/queue/queue";

export async function GET() {
  try {
    // Get basic statistics
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [channelCount, modelCount, checksLast24h, successCount] = await Promise.all([
      prisma.channel.count({ where: { enabled: true } }),
      prisma.model.count(),
      prisma.checkLog.count({
        where: {
          createdAt: {
            gte: last24Hours,
          },
        },
      }),
      prisma.checkLog.count({
        where: {
          createdAt: {
            gte: last24Hours,
          },
          status: "SUCCESS",
        },
      }),
    ]);

    // Calculate health rate
    const healthRate = checksLast24h > 0 ? Math.round((successCount / checksLast24h) * 100) : 0;

    // Get queue status
    let queueStats = null;
    try {
      queueStats = await getQueueStats();
    } catch {
      // Redis might not be available
    }

    return NextResponse.json({
      status: "operational",
      timestamp: new Date().toISOString(),
      statistics: {
        channels: channelCount,
        models: modelCount,
        checksLast24h,
        healthRate,
      },
      queue: queueStats
        ? {
            isRunning: isQueueRunning(queueStats),
            pending: queueStats.waiting + queueStats.delayed,
            active: queueStats.active,
            delayed: queueStats.delayed,
          }
        : null,
    });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        message: "Failed to fetch system status",
      },
      { status: 500 }
    );
  }
}
