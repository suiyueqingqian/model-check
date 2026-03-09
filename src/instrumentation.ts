// Next.js Instrumentation - Auto-start background services

export async function register() {
  // Only run in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initializeServices } = await import("@/lib/init");
      await initializeServices();

      // Graceful shutdown
      const shutdown = async () => {
        try {
          const { stopAllCrons } = await import("@/lib/scheduler/cron");
          const { stopWorker } = await import("@/lib/queue/worker");
          stopAllCrons();
          await stopWorker();
          const { default: prisma } = await import("@/lib/prisma");
          await prisma.$disconnect();
        } catch (e) {
          console.error("[Shutdown] 清理失败:", e);
        }
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (err) {
      console.error("[Instrumentation] Failed to initialize services:", err);
    }
  }
}
