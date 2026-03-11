// GET /api/dashboard - Get channels and models status with pagination and filtering

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isAuthenticated } from "@/lib/middleware/auth";
import { Prisma } from "@/generated/prisma";
import { supportsDisplayEndpoint } from "@/lib/utils/model-name";
import {
  getTemporaryStoppedChannelCredentialsByModelIds,
  shouldAllowAdminTemporaryStopBypass,
} from "@/lib/proxy";

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

    const channelWhere: Prisma.ChannelWhereInput = {
      enabled: true,
      models: { some: modelWhere ?? {} },
    };

    const channelOrderBy: Prisma.ChannelOrderByWithRelationInput[] = [
      { sortOrder: "asc" },
      { createdAt: "desc" },
    ];

    const fullSelect = {
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
            orderBy: { createdAt: "desc" as const },
            take: 7,
          },
        },
      },
    } satisfies Prisma.ChannelSelect;

    let channels: Array<{
      id: string;
      name: string;
      baseUrl?: string;
      createdAt: Date;
      models: Array<{
        id: string;
        modelName: string;
        detectedEndpoints: string[];
        lastStatus: boolean | null;
        lastLatency: number | null;
        lastCheckedAt: Date | null;
        checkLogs: Array<{
          id: string;
          status: "SUCCESS" | "FAIL";
          latency: number | null;
          statusCode: number | null;
          endpointType: string;
          responseContent: string | null;
          errorMsg: string | null;
          createdAt: Date;
        }>;
      }>;
    }>;
    const [lightChannels, summaryModels] = await Promise.all([
      prisma.channel.findMany({
        where: channelWhere,
        select: {
          id: true,
          models: {
            where: modelWhere,
            select: {
              id: true,
              modelName: true,
              detectedEndpoints: true,
            },
          },
        },
        orderBy: channelOrderBy,
      }),
      prisma.model.findMany({
        where: {
          channel: { enabled: true },
        },
        select: {
          id: true,
          channelId: true,
          lastStatus: true,
        },
      }),
    ]);

    const trackedModelIds = Array.from(
      new Set([
        ...lightChannels.flatMap((channel) => channel.models.map((model) => model.id)),
        ...summaryModels.map((model) => model.id),
      ])
    );
    const temporaryStoppedCredentialByModelId = await getTemporaryStoppedChannelCredentialsByModelIds(trackedModelIds);

    const filteredIds = lightChannels
      .filter((channel) =>
        channel.models.some((model) => {
          if (temporaryStoppedCredentialByModelId[model.id]) {
            return false;
          }

          if (endpointFilter === "all") {
            return true;
          }

          return supportsDisplayEndpoint(
            model.modelName,
            model.detectedEndpoints || [],
            endpointFilter
          );
        })
      )
      .map((channel) => channel.id);

    const totalFilteredChannels = filteredIds.length;
    const pageIds = filteredIds.slice((page - 1) * pageSize, page * pageSize);

    if (pageIds.length > 0) {
      const pageData = await prisma.channel.findMany({
        where: { id: { in: pageIds } },
        select: fullSelect,
        orderBy: channelOrderBy,
      });

      channels = pageData
        .map((channel) => ({
          ...channel,
          models: channel.models.filter((model) => {
            if (temporaryStoppedCredentialByModelId[model.id]) {
              return false;
            }

            if (endpointFilter === "all") {
              return true;
            }

            return supportsDisplayEndpoint(
              model.modelName,
              model.detectedEndpoints || [],
              endpointFilter
            );
          }),
        }))
        .filter((channel) => channel.models.length > 0);
    } else {
      channels = [];
    }

    const visibleSummaryModels = summaryModels.filter(
      (model) => !temporaryStoppedCredentialByModelId[model.id]
    );
    const totalChannelsCount = new Set(
      visibleSummaryModels.map((model) => model.channelId)
    ).size;
    const totalModels = visibleSummaryModels.length;
    const healthyModels = visibleSummaryModels.filter(
      (model) => model.lastStatus === true
    ).length;

    const totalPages = Math.ceil(totalFilteredChannels / pageSize);

    return NextResponse.json({
      authenticated,
      allowAdminTemporaryStopBypass: shouldAllowAdminTemporaryStopBypass(),
      summary: {
        totalChannels: totalChannelsCount,
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
      channels: channels.map((channel) => ({
        ...channel,
        models: channel.models.map((model) => ({
          ...model,
          temporaryStoppedCredential: authenticated
            ? temporaryStoppedCredentialByModelId[model.id] || null
            : null,
        })),
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch dashboard data", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
