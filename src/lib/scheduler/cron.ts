// Cron scheduler for periodic tasks

import { CronJob } from "cron";
import { triggerFullDetection } from "@/lib/queue/service";
import prisma from "@/lib/prisma";

// Auto detection switch (default: enabled)
const AUTO_DETECT_ENABLED = process.env.AUTO_DETECT_ENABLED !== "false";

// Default: at 0:00, 8:00, 12:00, 16:00, 20:00 every day
const DETECTION_SCHEDULE = process.env.CRON_SCHEDULE || "0 0,8,12,16,20 * * *";

// Cleanup: daily at 2 AM
const CLEANUP_SCHEDULE = process.env.CLEANUP_SCHEDULE || "0 2 * * *";

// Timezone for cron jobs
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || "Asia/Shanghai";

// Log retention days
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "7", 10);

let detectionJob: CronJob | null = null;
let cleanupJob: CronJob | null = null;

/**
 * Start detection cron job
 */
export function startDetectionCron(): CronJob | null {
  if (!AUTO_DETECT_ENABLED) {
    console.log("[Cron] Auto detection is disabled");
    return null;
  }

  if (detectionJob) {
    console.log("[Cron] Detection job already running");
    return detectionJob;
  }

  detectionJob = new CronJob(
    DETECTION_SCHEDULE,
    async () => {
      console.log("[Cron] Starting scheduled detection with model sync...");
      try {
        // Sync models from remote API before detection
        const result = await triggerFullDetection(true);
        console.log(
          `[Cron] Detection scheduled: ${result.channelCount} channels, ${result.modelCount} models`
        );
        if (result.syncResults) {
          const totalAdded = result.syncResults.reduce((sum, r) => sum + r.added, 0);
          if (totalAdded > 0) {
            console.log(`[Cron] Model sync: ${totalAdded} new models added`);
          }
        }
      } catch (error) {
        console.error("[Cron] Detection failed:", error);
      }
    },
    null, // onComplete
    true, // start immediately
    CRON_TIMEZONE // timezone
  );

  console.log(`[Cron] Detection job started with schedule: ${DETECTION_SCHEDULE}`);
  return detectionJob;
}

/**
 * Start cleanup cron job
 */
export function startCleanupCron(): CronJob {
  if (cleanupJob) {
    console.log("[Cron] Cleanup job already running");
    return cleanupJob;
  }

  cleanupJob = new CronJob(
    CLEANUP_SCHEDULE,
    async () => {
      console.log("[Cron] Starting scheduled cleanup...");
      try {
        const result = await cleanupOldLogs();
        console.log(`[Cron] Cleanup complete: ${result.deleted} logs removed`);
      } catch (error) {
        console.error("[Cron] Cleanup failed:", error);
      }
    },
    null, // onComplete
    true, // start immediately
    CRON_TIMEZONE // timezone
  );

  console.log(`[Cron] Cleanup job started with schedule: ${CLEANUP_SCHEDULE}`);
  return cleanupJob;
}

/**
 * Clean up old check logs
 */
export async function cleanupOldLogs(): Promise<{ deleted: number }> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);

  console.log(`[Cleanup] Removing logs older than ${cutoffDate.toISOString()}`);

  const result = await prisma.checkLog.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
    },
  });

  return { deleted: result.count };
}

/**
 * Stop all cron jobs
 */
export function stopAllCrons(): void {
  if (detectionJob) {
    detectionJob.stop();
    detectionJob = null;
    console.log("[Cron] Detection job stopped");
  }

  if (cleanupJob) {
    cleanupJob.stop();
    cleanupJob = null;
    console.log("[Cron] Cleanup job stopped");
  }
}

/**
 * Calculate next run time from cron expression
 */
function getNextRunTime(cronExpression: string): string | null {
  try {
    // Create a temporary CronJob to calculate next run time
    const tempJob = new CronJob(cronExpression, () => {}, null, false, CRON_TIMEZONE);
    const nextDate = tempJob.nextDate();
    return nextDate?.toISO() ?? null;
  } catch {
    return null;
  }
}

/**
 * Get cron status
 */
export function getCronStatus() {
  return {
    detection: {
      enabled: AUTO_DETECT_ENABLED,
      running: detectionJob !== null,
      schedule: DETECTION_SCHEDULE,
      nextRun: AUTO_DETECT_ENABLED ? getNextRunTime(DETECTION_SCHEDULE) : null,
    },
    cleanup: {
      running: cleanupJob !== null,
      schedule: CLEANUP_SCHEDULE,
      nextRun: getNextRunTime(CLEANUP_SCHEDULE),
      retentionDays: LOG_RETENTION_DAYS,
    },
  };
}

/**
 * Start all cron jobs
 */
export function startAllCrons(): void {
  startDetectionCron();
  startCleanupCron();
}
