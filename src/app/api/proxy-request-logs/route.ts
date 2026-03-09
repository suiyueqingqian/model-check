import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { Prisma } from "@/generated/prisma";

const DEFAULT_PAGE_SIZE = 20;

function buildWhere(
  search: string,
  endpointType: string,
  status: string
): Prisma.ProxyRequestLogWhereInput {
  const where: Prisma.ProxyRequestLogWhereInput = {};

  if (search) {
    where.OR = [
      { requestedModel: { contains: search, mode: "insensitive" } },
      { actualModelName: { contains: search, mode: "insensitive" } },
      { channelName: { contains: search, mode: "insensitive" } },
      { proxyKeyName: { contains: search, mode: "insensitive" } },
      { requestPath: { contains: search, mode: "insensitive" } },
      { errorMsg: { contains: search, mode: "insensitive" } },
    ];
  }

  if (endpointType !== "all") {
    where.endpointType = endpointType as Prisma.ProxyRequestLogWhereInput["endpointType"];
  }

  if (status === "success") {
    where.success = true;
  } else if (status === "fail") {
    where.success = false;
  }

  return where;
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) {
    return authError;
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(1, Math.min(100, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10)));
  const search = searchParams.get("search")?.trim() || "";
  const endpointType = searchParams.get("endpointType") || "all";
  const status = searchParams.get("status") || "all";
  const where = buildWhere(search, endpointType, status);

  try {
    const [total, logs] = await Promise.all([
      prisma.proxyRequestLog.count({ where }),
      prisma.proxyRequestLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          requestPath: true,
          requestMethod: true,
          endpointType: true,
          requestedModel: true,
          actualModelName: true,
          channelName: true,
          proxyKeyName: true,
          isStream: true,
          success: true,
          statusCode: true,
          latency: true,
          errorMsg: true,
          createdAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch proxy request logs", code: "FETCH_PROXY_REQUEST_LOGS_ERROR" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const mode = typeof body.mode === "string" ? body.mode : "";

    if (mode === "single") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json(
          { error: "日志 ID 不能为空", code: "MISSING_ID" },
          { status: 400 }
        );
      }

      await prisma.proxyRequestLog.delete({
        where: { id },
      });

      return NextResponse.json({ success: true, deletedCount: 1 });
    }

    if (mode === "filtered") {
      const search = typeof body.search === "string" ? body.search.trim() : "";
      const endpointType = typeof body.endpointType === "string" ? body.endpointType : "all";
      const status = typeof body.status === "string" ? body.status : "all";
      const where = buildWhere(search, endpointType, status);
      const result = await prisma.proxyRequestLog.deleteMany({ where });

      return NextResponse.json({
        success: true,
        deletedCount: result.count,
      });
    }

    if (mode === "all") {
      const result = await prisma.proxyRequestLog.deleteMany({});
      return NextResponse.json({
        success: true,
        deletedCount: result.count,
      });
    }

    return NextResponse.json(
      { error: "不支持的删除模式", code: "INVALID_MODE" },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { error: "删除代理请求日志失败", code: "DELETE_PROXY_REQUEST_LOGS_ERROR" },
      { status: 500 }
    );
  }
}
