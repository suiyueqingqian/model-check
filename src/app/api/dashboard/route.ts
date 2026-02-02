// GET /api/dashboard - Get channels and models status

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isAuthenticated } from "@/lib/middleware/auth";

export async function GET(request: NextRequest) {
  const authenticated = isAuthenticated(request);

  try {
    // Fetch all enabled channels with models and recent check logs
    const channels = await prisma.channel.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        baseUrl: authenticated, // Only show baseUrl to authenticated users
        createdAt: true,
        models: {
          select: {
            id: true,
            modelName: true,
            detectedEndpoints: true,
            lastStatus: true,
            lastLatency: true,
            lastCheckedAt: true,
            checkLogs: {
              select: {
                id: true,
                status: true,
                latency: true,
                statusCode: true,
                endpointType: true,
                responseContent: true,
                errorMsg: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
              take: 7, // Last 7 checks for heatmap
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Calculate summary statistics based on checkLogs per endpoint
    const totalChannels = channels.length;
    const totalModels = channels.reduce((sum, ch) => sum + ch.models.length, 0);

    // A model is healthy if all its tested endpoints are successful
    const healthyModels = channels.reduce((sum, ch) => {
      return sum + ch.models.filter((m) => {
        if (m.checkLogs.length === 0) return false;

        // Get latest status for each endpoint type
        const endpointStatuses: Record<string, string> = {};
        for (const log of m.checkLogs) {
          if (!endpointStatuses[log.endpointType]) {
            endpointStatuses[log.endpointType] = log.status;
          }
        }

        // Model is healthy only if all tested endpoints are successful
        const statuses = Object.values(endpointStatuses);
        return statuses.length > 0 && statuses.every((s) => s === "SUCCESS");
      }).length;
    }, 0);

    return NextResponse.json({
      authenticated,
      summary: {
        totalChannels,
        totalModels,
        healthyModels,
        healthRate: totalModels > 0 ? Math.round((healthyModels / totalModels) * 100) : 0,
      },
      channels,
    });
  } catch (error) {
    console.error("[API] Dashboard error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard data", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
