import "server-only";

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { plannedRestartBusyReasons } from "@/lib/planned-restart-policy";
import { getRpaQueueStatus } from "@/lib/rpa-job-queue";

const COMPETITOR_LOCK_PATH = resolve("rpa/.locks/competitor-monitor.lock");

export async function getPlannedRestartReadiness() {
  const [competitorScanRunning, sendingCustomerNotifications] = await Promise.all([
    stat(COMPETITOR_LOCK_PATH).then(() => true).catch(() => false),
    prisma.reservation.count({ where: { notificationStatus: "SENDING" } }),
  ]);
  const queue = getRpaQueueStatus();
  const reasons = plannedRestartBusyReasons({
    queue,
    competitorScanRunning,
    sendingCustomerNotifications,
  });
  return {
    idle: reasons.length === 0,
    reasons,
    queue,
    competitorScanRunning,
    sendingCustomerNotifications,
    checkedAt: new Date().toISOString(),
  };
}
