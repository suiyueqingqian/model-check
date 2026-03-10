"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProxyRequestLog } from "@/components/dashboard/proxy-request-log";

export default function ProxyLogsPage() {
  return (
    <div className="min-h-screen bg-background dark:bg-muted/10">
      <div className="container mx-auto max-w-7xl px-4 py-5 md:py-6">
        <div className="mb-4 grid items-center gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <Link
            href="/"
            className="inline-flex w-fit shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </Link>
          <div className="min-w-0 md:text-center">
            <h1 className="truncate text-xl font-semibold text-foreground md:text-2xl">
              代理 API 日志
            </h1>
          </div>
          <div className="hidden md:block" />
        </div>

        <ProxyRequestLog standalone />
      </div>
    </div>
  );
}
