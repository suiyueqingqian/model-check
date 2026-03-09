"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProxyRequestLog } from "@/components/dashboard/proxy-request-log";

export default function ProxyLogsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4">
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回监控面板
          </Link>
        </div>

        <ProxyRequestLog standalone />
      </div>
    </div>
  );
}
