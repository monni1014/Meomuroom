export async function registerNodeInstrumentation() {
  const serverWorkersEnabled =
    process.platform === "linux" &&
    process.env.RPA_EXECUTION_ENABLED?.trim().toLowerCase() === "true";

  if (process.env.DISABLE_BACKGROUND_JOBS === "1" || !serverWorkersEnabled) {
    console.log("[Cron] Background jobs disabled on this host");
    return;
  }

  const g = globalThis as unknown as { __emailSyncCronStarted?: boolean };
  if (g.__emailSyncCronStarted) return;
  g.__emailSyncCronStarted = true;

  const { schedule } = await import("node-cron");
  const { syncEmails } = await import("@/lib/email-sync");
  const { enqueueNaverStatusReconcile } = await import("@/lib/rpa-job-queue");
  const { checkProxySellerStatusAndAlert } = await import("@/lib/proxy-seller");
  const { sendDueReservationReminders } = await import("@/lib/reservation-notifications");
  const { runReservationContactPreflight } = await import("@/lib/reservation-contact-preflight");
  const { runCompetitorScan } = await import("@/lib/competitor-monitor");
  const { runRpaUiHealthChecks } = await import("@/lib/rpa-ui-monitor");

  let running = false;
  let proxyStatusRunning = false;
  let naverStatusReconcileRunning = false;
  let notificationRunning = false;
  let contactPreflightRunning = false;
  let competitorScanRunning = false;
  let rpaUiHealthRunning = false;

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

  async function runProxyStatusCheck(label: string) {
    if (proxyStatusRunning) {
      console.log(`[Cron] Previous ISP proxy status check is still running. Skipping ${label}.`);
      return;
    }

    proxyStatusRunning = true;
    try {
      const result = await checkProxySellerStatusAndAlert();
      console.log(`[Cron] ISP proxy status check done (${label}): ${result.summary}`);
    } catch (error) {
      console.error(`[Cron] ISP proxy status check failed (${label}):`, error);
    } finally {
      proxyStatusRunning = false;
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

  async function runContactPreflight(label: string) {
    if (contactPreflightRunning) return;
    contactPreflightRunning = true;
    try {
      const result = await runReservationContactPreflight();
      if (result.missingCount > 0) {
        console.warn(
          `[Cron] Reservation contact preflight (${label}): checked ${result.checkedCount}, missing ${result.missingCount}, critical ${result.criticalCount}`,
        );
      }
    } catch (error) {
      console.error(`[Cron] Reservation contact preflight failed (${label}):`, error);
    } finally {
      contactPreflightRunning = false;
    }
  }

  async function runCompetitorMonitor(
    label: string,
    mode: "today" | "today-next" | "next-week" | "daily" | "weekly" | "monthly",
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

  async function runRpaUiHealthMonitor(label: string) {
    if (rpaUiHealthRunning) {
      console.log(`[Cron] Previous RPA UI health check is still running. Skipping ${label}.`);
      return;
    }

    rpaUiHealthRunning = true;
    try {
      const result = await runRpaUiHealthChecks();
      const summary = result.results
        .map((item) => `${item.platform}=${item.status}`)
        .join(", ");
      console.log(`[Cron] RPA UI health check ${result.skipped ? "skipped" : "done"} (${label}): ${summary || result.reason || "-"}`);
    } catch (error) {
      console.error(`[Cron] RPA UI health check failed (${label}):`, error);
    } finally {
      rpaUiHealthRunning = false;
    }
  }

  setTimeout(() => {
    void runEmailSync("startup");
  }, 0);

  setTimeout(() => {
    void runProxyStatusCheck("startup");
  }, 10_000);

  setTimeout(() => {
    void runReservationNotifications("startup");
  }, 15_000);

  setTimeout(() => {
    void runContactPreflight("startup");
  }, 20_000);

  setTimeout(() => {
    void runCompetitorMonitor("startup", "today-next", 120);
  }, 60_000);

  schedule("*/15 * * * * *", async () => {
    await runEmailSync("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runProxyStatusCheck("cron");
  });

  schedule("* * * * *", async () => {
    await runReservationNotifications("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runContactPreflight("cron");
  });

  schedule("0 10,22 * * *", async () => {
    await runNaverStatusReconcile("cron");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("20 2,8,14,20 * * *", async () => {
    await runRpaUiHealthMonitor("scheduled read-only check");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 7 2-31 * *", async () => {
    await runCompetitorMonitor("07:00 today and tomorrow", "today-next");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 12 * * *", async () => {
    await runCompetitorMonitor("12:00 next seven days", "next-week");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 18 * * *", async () => {
    await runCompetitorMonitor("18:00 next seven days", "next-week");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 23 * * *", async () => {
    await runCompetitorMonitor("23:00 next seven days", "next-week");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 7 1 * *", async () => {
    await runCompetitorMonitor("monthly", "monthly");
  }, {
    timezone: "Asia/Seoul",
  });

  console.log("[Cron] Email auto sync started (15 second interval)");
  console.log("[Cron] Reservation notification monitor started (1 minute interval)");
  console.log("[Cron] Reservation contact preflight started (5 minute interval)");
  console.log("[Cron] ISP proxy status monitor started (5 minute interval)");
  console.log("[Cron] Naver status reconcile started (10:00/22:00 daily)");
  console.log("[Cron] RPA UI health monitor started (02:20/08:20/14:20/20:20 read-only checks)");
  console.log("[Cron] Competitor monitor started (07:00 today+tomorrow, 12:00/18:00/23:00 next 7 days, monthly baseline at 07:00 on day 1)");
}
