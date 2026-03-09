"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProxyRequestLog } from "@/components/dashboard/proxy-request-log";

export default function ProxyLogsPage() {
  return (
    <div className="min-h-screen bg-background dark:bg-muted/10">
      <div className="container mx-auto max-w-7xl px-4 py-5 md:py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-foreground md:text-2xl">
              代理 API 日志
            </h1>
          </div>
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </Link>
        </div>

        <ProxyRequestLog standalone />
      </div>
    </div>
  );
}
