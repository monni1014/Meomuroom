export async function registerNodeInstrumentation() {
  const g = globalThis as unknown as { __emailSyncCronStarted?: boolean };
  if (g.__emailSyncCronStarted) return;
  g.__emailSyncCronStarted = true;

  const { schedule } = await import("node-cron");
  const { syncEmails } = await import("@/lib/email-sync");
  const { enqueueNaverStatusReconcile } = await import("@/lib/rpa-job-queue");
  const { checkIproyalTrafficAndAlert } = await import("@/lib/iproyal-traffic");
  const { sendDueReservationReminders } = await import("@/lib/reservation-notifications");
  const { runCompetitorScan } = await import("@/lib/competitor-monitor");
  const { captureSynergyCutoffStudy } = await import("@/lib/competitor-cutoff-study");

  let running = false;
  let proxyTrafficRunning = false;
  let naverStatusReconcileRunning = false;
  let notificationRunning = false;
  let competitorScanRunning = false;
  let cutoffCaptureRunning = false;

  async function runEmailSync(label: string) {
    if (running) {
      console.log(`[Cron] Previous email sync is still running. Skipping ${label}.`);
      return;
    }

    running = true;
    try {
      const result = await syncEmails();
      console.log(
        `[Cron] Email sync done (${label}): checked ${result.processed}, changed ${result.newReservations}, queued RPA ${result.queuedRpaJobs ?? 0}`,
      );
    } catch (error) {
      console.error(`[Cron] Email sync failed (${label}):`, error);
    } finally {
      running = false;
    }
  }

  async function runProxyTrafficCheck(label: string) {
    if (proxyTrafficRunning) {
      console.log(`[Cron] Previous proxy traffic check is still running. Skipping ${label}.`);
      return;
    }

    proxyTrafficRunning = true;
    try {
      const result = await checkIproyalTrafficAndAlert();
      if (result.severity !== "NOT_CONFIGURED") {
        console.log(`[Cron] IPRoyal traffic check done (${label}): ${result.message}`);
      }
    } catch (error) {
      console.error(`[Cron] IPRoyal traffic check failed (${label}):`, error);
    } finally {
      proxyTrafficRunning = false;
    }
  }

  async function runNaverStatusReconcile(label: string) {
    if (naverStatusReconcileRunning) {
      console.log(`[Cron] Previous Naver status reconcile is still running. Skipping ${label}.`);
      return;
    }

    naverStatusReconcileRunning = true;
    try {
      const queued = enqueueNaverStatusReconcile();
      console.log(`[Cron] Naver status reconcile ${queued ? "queued" : "skipped"} (${label})`);
    } catch (error) {
      console.error(`[Cron] Naver status reconcile failed (${label}):`, error);
    } finally {
      naverStatusReconcileRunning = false;
    }
  }

  async function runReservationNotifications(label: string) {
    if (notificationRunning) {
      console.log(`[Cron] Previous reservation notification check is still running. Skipping ${label}.`);
      return;
    }

    notificationRunning = true;
    try {
      const result = await sendDueReservationReminders();
      if (result.checkedCount > 0) {
        console.log(
          `[Cron] Reservation notifications done (${label}): checked ${result.checkedCount}, sent ${result.sentCount}, dry-run ${result.dryRunCount}, failed ${result.failedCount}`,
        );
      }
    } catch (error) {
      console.error(`[Cron] Reservation notification check failed (${label}):`, error);
    } finally {
      notificationRunning = false;
    }
  }

  async function runCompetitorMonitor(
    label: string,
    mode: "daily" | "weekly" | "monthly",
    skipIfRecentMinutes?: number,
  ) {
    if (competitorScanRunning) {
      console.log(`[Cron] Previous competitor scan is still running. Skipping ${label}.`);
      return;
    }

    competitorScanRunning = true;
    try {
      const result = await runCompetitorScan({ mode, skipIfRecentMinutes });
      console.log(
        `[Cron] Competitor scan ${result.skipped ? "skipped" : "done"} (${label}): status ${result.status || "-"}, checked ${result.checkedSlots || 0}, changed ${result.changedSlots || 0}`,
      );
    } catch (error) {
      console.error(`[Cron] Competitor scan failed (${label}):`, error);
    } finally {
      competitorScanRunning = false;
    }
  }

  async function runCutoffCapture(label: string) {
    if (cutoffCaptureRunning) {
      console.log(`[Cron] Previous cutoff capture is still running. Skipping ${label}.`);
      return;
    }

    cutoffCaptureRunning = true;
    try {
      const result = await captureSynergyCutoffStudy();
      if (result) console.log(`[Cron] Synergy cutoff captured (${label}): ${result.checkedAtKst}`);
    } catch (error) {
      console.error(`[Cron] Synergy cutoff capture failed (${label}):`, error);
    } finally {
      cutoffCaptureRunning = false;
    }
  }

  setTimeout(() => {
    void runEmailSync("startup");
  }, 0);

  setTimeout(() => {
    void runProxyTrafficCheck("startup");
  }, 10_000);

  setTimeout(() => {
    void runReservationNotifications("startup");
  }, 15_000);

  setTimeout(() => {
    void runCompetitorMonitor("startup", "daily", 120);
  }, 60_000);

  schedule("*/15 * * * * *", async () => {
    await runEmailSync("cron");
  });

  schedule("*/10 * * * *", async () => {
    await runProxyTrafficCheck("cron");
  });

  schedule("* * * * *", async () => {
    await runReservationNotifications("cron");
  });

  schedule("0 10,22 * * *", async () => {
    await runNaverStatusReconcile("cron");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 7 2-31 * *", async () => {
    await runCompetitorMonitor("daily", "daily");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 12,18,23 * * *", async () => {
    await runCompetitorMonitor("daily", "daily");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("30 0 * * 1", async () => {
    await runCompetitorMonitor("weekly", "weekly");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 7 1 * *", async () => {
    await runCompetitorMonitor("monthly", "monthly");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("55 10,11,15,18,20 * * *", async () => {
    await runCutoffCapture("before-hour");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("5 11,12,16,19,21 * * *", async () => {
    await runCutoffCapture("after-hour");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("25 11,16 * * *", async () => {
    await runCutoffCapture("mid-hour");
  }, {
    timezone: "Asia/Seoul",
  });

  console.log("[Cron] Email auto sync started (15 second interval)");
  console.log("[Cron] Reservation notification monitor started (1 minute interval)");
  console.log("[Cron] IPRoyal traffic monitor started (10 minute interval)");
  console.log("[Cron] Naver status reconcile started (10:00/22:00 daily)");
  console.log("[Cron] Competitor monitor started (07:00/12:00/18:00/23:00, monthly baseline at 07:00 on day 1)");
  console.log("[Cron] Synergy cutoff study capture schedule registered (10:55/11:05/11:25/11:55/12:05/15:55/16:05/16:25/18:55/19:05/20:55/21:05)");
}
