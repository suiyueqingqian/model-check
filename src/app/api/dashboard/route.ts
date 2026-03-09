// GET /api/dashboard - Get channels and models status with pagination and filtering

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isAuthenticated } from "@/lib/middleware/auth";
import { Prisma } from "@/generated/prisma";
import { supportsDisplayEndpoint, isResponsesCompatibleChatModel } from "@/lib/utils/model-name";

const DEFAULT_PAGE_SIZE = 10;

export async function GET(request: NextRequest) {
  const authenticated = isAuthenticated(request);

  // Parse pagination parameters
  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(1, Math.min(100, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10)));

  // Parse filter parameters
  const search = searchParams.get("search")?.trim() || "";
  const endpointFilter = searchParams.get("endpointFilter") || "all";
  const statusFilter = searchParams.get("statusFilter") || "all";

  try {
    // Build model filter conditions
    const modelWhereConditions: Prisma.ModelWhereInput[] = [];

    // Search filter - filter by model name
    if (search) {
      modelWhereConditions.push({
        modelName: { contains: search, mode: "insensitive" },
      });
    }

    // Status filter - filter by lastStatus
    if (statusFilter === "healthy") {
      modelWhereConditions.push({ lastStatus: true });
    } else if (statusFilter === "unhealthy") {
      modelWhereConditions.push({ lastStatus: false });
    } else if (statusFilter === "unknown") {
      modelWhereConditions.push({ lastStatus: null });
    }

    const modelWhere: Prisma.ModelWhereInput | undefined =
      modelWhereConditions.length > 0 ? { AND: modelWhereConditions } : undefined;

    const baseChannels = await prisma.channel.findMany({
      where: {
        enabled: true,
        models: { some: modelWhere ?? {} },
      },
      select: {
        id: true,
        name: true,
        baseUrl: authenticated,
        createdAt: true,
        models: {
          where: modelWhere,
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
              take: 7,
            },
          },
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "desc" },
      ],
    });

    const filteredChannels = endpointFilter === "all"
      ? baseChannels
      : baseChannels
          .map((channel) => ({
            ...channel,
            models: channel.models.filter((model) =>
              supportsDisplayEndpoint(model.modelName, model.detectedEndpoints || [], endpointFilter)
            ),
          }))
          .filter((channel) => channel.models.length > 0);

    const totalFilteredChannels = filteredChannels.length;
    const channels = filteredChannels.slice((page - 1) * pageSize, page * pageSize);

    // Calculate summary statistics for ALL channels (not just current page)
    const allChannelsForStats = await prisma.channel.findMany({
      where: { enabled: true },
      select: {
        models: {
          select: {
            id: true,
            modelName: true,
            lastStatus: true,
            checkLogs: {
              select: {
                status: true,
                endpointType: true,
              },
              orderBy: { createdAt: "desc" },
              take: 7,
            },
          },
        },
      },
    });

    const totalModels = allChannelsForStats.reduce((sum, ch) => sum + ch.models.length, 0);

    // A model is healthy if all its tested endpoints are successful
    const healthyModels = allChannelsForStats.reduce((sum, ch) => {
      return sum + ch.models.filter((m) => {
        if (m.checkLogs.length === 0) return false;

        // 使用与前端一致的语义端点逻辑（合并 CHAT/CODEX）
        const endpointStatuses: Record<string, string> = {};
        const chatLikeLogs: typeof m.checkLogs = [];

        for (const log of m.checkLogs) {
          if (isResponsesCompatibleChatModel(m.modelName) && (log.endpointType === "CHAT" || log.endpointType === "CODEX")) {
            chatLikeLogs.push(log);
            continue;
          }
          if (!endpointStatuses[log.endpointType]) {
            endpointStatuses[log.endpointType] = log.status;
          }
        }

        if (chatLikeLogs.length > 0) {
          endpointStatuses.CHAT = chatLikeLogs.some((log) => log.status === "SUCCESS") ? "SUCCESS" : "FAIL";
        }

        // Model is healthy only if all tested endpoints are successful
        const statuses = Object.values(endpointStatuses);
        return statuses.length > 0 && statuses.every((s) => s === "SUCCESS");
      }).length;
    }, 0);

    const totalPages = Math.ceil(totalFilteredChannels / pageSize);

    return NextResponse.json({
      authenticated,
      summary: {
        totalChannels: allChannelsForStats.length,
        totalModels,
        healthyModels,
        healthRate: totalModels > 0 ? Math.round((healthyModels / totalModels) * 100) : 0,
      },
      pagination: {
        page,
        pageSize,
        totalPages,
        totalChannels: totalFilteredChannels,
      },
      channels,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch dashboard data", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
