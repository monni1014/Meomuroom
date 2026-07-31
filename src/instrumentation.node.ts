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
  const { enqueueNaverStatusReconcile, resumeRpaWorkAfterProxyRecovery } = await import("@/lib/rpa-job-queue");
  const { checkProxySellerStatusAndAlert } = await import("@/lib/proxy-seller");
  const {
    initializeRpaProxyCircuitCheck,
    isRpaPausedForProxy,
    updateRpaProxyCircuit,
  } = await import("@/lib/rpa-proxy-circuit");
  const { sendDueReservationReminders } = await import("@/lib/reservation-notifications");
  const { sendDueDawnBookingConfirmations } = await import("@/lib/dawn-booking-notifications");
  const { sendDueSiteVisitGuides } = await import("@/lib/site-visit-notifications");
  const { sendDueOnTimeExitMessages } = await import("@/lib/on-time-exit-notifications");
  const { sendDueReservationEndReminders } = await import("@/lib/reservation-end-reminders");
  const { runReservationContactPreflight } = await import("@/lib/reservation-contact-preflight");
  const { syncUpcomingReservationContacts } = await import("@/lib/google-people");
  const { runCompetitorScan } = await import("@/lib/competitor-monitor");
  const { resolveCompetitorStartupMode } = await import("@/lib/competitor-scan-range");
  const { runRpaUiHealthChecks } = await import("@/lib/rpa-ui-monitor");
  const { checkTailscaleDevicesAndAlert } = await import("@/lib/tailscale-device-monitor");
  const { checkRpaSessionExpiryWarnings } = await import("@/lib/rpa-session-expiry-monitor");

  let running = false;
  let proxyStatusRunning = false;
  let naverStatusReconcileRunning = false;
  let notificationRunning = false;
  let endReminderRunning = false;
  let contactPreflightRunning = false;
  let googlePeopleSyncRunning = false;
  let competitorScanRunning = false;
  let rpaUiHealthRunning = false;
  let tailscaleDeviceMonitorRunning = false;
  let rpaSessionExpiryRunning = false;
  const pendingCompetitorScans: Array<{
    label: string;
    mode: "today" | "today-next" | "today-plus-seven" | "night-month-horizon" | "next-week" | "daily" | "weekly" | "monthly";
    skipIfRecentMinutes?: number;
  }> = [];
  let rpaUiHealthPending = false;

  initializeRpaProxyCircuitCheck();

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
      if (result.newReservations > 0) {
        await runReservationNotifications(`after email sync: ${label}`);
      }
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
      const circuit = updateRpaProxyCircuit(result);
      console.log(`[Cron] ISP proxy status check done (${label}): ${result.summary}`);
      if (circuit.transition === "PAUSED") {
        console.warn(`[Cron] Proxy circuit opened. RPA work is paused; email sync remains active: ${circuit.state.reason}`);
      } else if (circuit.transition === "RESUMED") {
        console.log("[Cron] Proxy circuit recovered. Resuming queued RPA work.");
        resumeRpaWorkAfterProxyRecovery();
        void resumeProxyPausedCronWork();
      }
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
      const dawnResult = await sendDueDawnBookingConfirmations();
      const result = await sendDueReservationReminders();
      const siteVisitResult = await sendDueSiteVisitGuides();
      const exitResult = await sendDueOnTimeExitMessages();
      if (result.checkedCount > 0 || dawnResult.checkedCount > 0 || siteVisitResult.checkedCount > 0 || exitResult.checkedCount > 0) {
        console.log(
          `[Cron] Reservation notifications done (${label}): guide checked ${result.checkedCount}, sent ${result.sentCount}, recovered ${result.recoveredCount}, recovery-waiting ${result.recoveryWaitingCount}, dry-run ${result.dryRunCount}, waiting-contact ${result.waitingContactCount}, waiting-contact-sync ${result.waitingContactSyncCount}, failed ${result.failedCount}, google-sync ${result.contactSyncMs}ms, pipeline ${result.pipelineMs}ms; dawn checked ${dawnResult.checkedCount}, sent ${dawnResult.sentCount}, recovered ${dawnResult.recoveredCount}, recovery-waiting ${dawnResult.recoveryWaitingCount}, dry-run ${dawnResult.dryRunCount}, waiting-contact ${dawnResult.waitingContactCount}, contact-sync-failed ${dawnResult.contactSyncFailureCount}, contact-sync-timeout ${dawnResult.contactSyncTimeoutCount}, failed ${dawnResult.failedCount}, skipped ${dawnResult.skippedCount}, pipeline ${dawnResult.pipelineMs}ms; site-visit checked ${siteVisitResult.checkedCount}, sent ${siteVisitResult.sentCount}, recovered ${siteVisitResult.recoveredCount}, recovery-waiting ${siteVisitResult.recoveryWaitingCount}, dry-run ${siteVisitResult.dryRunCount}, waiting-contact ${siteVisitResult.waitingContactCount}, waiting-template ${siteVisitResult.waitingTemplateCount}, failed ${siteVisitResult.failedCount}, template-ready ${siteVisitResult.templateReady}, pipeline ${siteVisitResult.pipelineMs}ms; on-time-exit checked ${exitResult.checkedCount}, sent ${exitResult.sentCount}, recovered ${exitResult.recoveredCount}, recovery-waiting ${exitResult.recoveryWaitingCount}, dry-run ${exitResult.dryRunCount}, failed ${exitResult.failedCount}, skipped ${exitResult.skippedCount}, template-ready ${exitResult.templateReady}`,
        );
      }
    } catch (error) {
      console.error(`[Cron] Reservation notification check failed (${label}):`, error);
    } finally {
      notificationRunning = false;
    }
  }

  async function runReservationEndReminders(label: string) {
    if (endReminderRunning) return;
    endReminderRunning = true;
    try {
      const result = await sendDueReservationEndReminders();
      if (result.groupCount > 0) {
        console.log(
          `[Cron] Reservation end reminders (${label}): checked ${result.checkedCount}, groups ${result.groupCount}, sent ${result.sentCount}, failed ${result.failedCount}, skipped ${result.skippedCount}`,
        );
      }
    } catch (error) {
      console.error(`[Cron] Reservation end reminder failed (${label}):`, error);
    } finally {
      endReminderRunning = false;
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

  async function runGooglePeopleSync(label: string) {
    if (googlePeopleSyncRunning) return;
    googlePeopleSyncRunning = true;
    try {
      const result = await syncUpcomingReservationContacts();
      if (!result.skipped) {
        console.log(
          `[Cron] Google contacts sync (${label}): checked ${result.checkedCount}, created ${result.createdCount}, updated ${result.updatedCount}, unchanged ${result.unchangedCount}, deleted ${result.deletedCount}, restored ${result.restoredCount}`,
        );
      }
    } catch (error) {
      console.error(`[Cron] Google contacts sync failed (${label}):`, error);
    } finally {
      googlePeopleSyncRunning = false;
    }
  }

  async function runCompetitorMonitor(
    label: string,
    mode: "today" | "today-next" | "today-plus-seven" | "night-month-horizon" | "next-week" | "daily" | "weekly" | "monthly",
    skipIfRecentMinutes?: number,
  ) {
    if (isRpaPausedForProxy()) {
      const exists = pendingCompetitorScans.some((item) => (
        item.mode === mode && item.skipIfRecentMinutes === skipIfRecentMinutes
      ));
      if (!exists) pendingCompetitorScans.push({ label, mode, skipIfRecentMinutes });
      console.warn(`[Cron] Competitor scan held until proxy recovery (${label}).`);
      return;
    }

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
    if (isRpaPausedForProxy()) {
      rpaUiHealthPending = true;
      console.warn(`[Cron] RPA UI health check held until proxy recovery (${label}).`);
      return;
    }

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

  async function runTailscaleDeviceMonitor(label: string) {
    if (tailscaleDeviceMonitorRunning) {
      console.log(`[Cron] Previous Tailscale device check is still running. Skipping ${label}.`);
      return;
    }

    tailscaleDeviceMonitorRunning = true;
    try {
      const result = await checkTailscaleDevicesAndAlert();
      const summary = result.results.map((item) => `${item.label}=${item.status}`).join(", ");
      console.log(`[Cron] Tailscale device check ${result.skipped ? "skipped" : "done"} (${label}): ${summary || result.reason || "-"}`);
    } catch (error) {
      console.error(`[Cron] Tailscale device check failed (${label}):`, error);
    } finally {
      tailscaleDeviceMonitorRunning = false;
    }
  }

  async function runRpaSessionExpiryMonitor(label: string) {
    if (rpaSessionExpiryRunning) {
      console.log(`[Cron] Previous RPA session expiry check is still running. Skipping ${label}.`);
      return;
    }

    rpaSessionExpiryRunning = true;
    try {
      const result = await checkRpaSessionExpiryWarnings();
      const summary = result.results
        .map((item) => `${item.platform}=${item.status}${"remainingDays" in item ? `(${item.remainingDays}d)` : ""}`)
        .join(", ");
      console.log(`[Cron] RPA session expiry check done (${label}): ${summary || "-"}`);
    } catch (error) {
      console.error(`[Cron] RPA session expiry check failed (${label}):`, error);
    } finally {
      rpaSessionExpiryRunning = false;
    }
  }

  async function resumeProxyPausedCronWork() {
    if (isRpaPausedForProxy()) return;

    const scans = pendingCompetitorScans.splice(0);
    for (const scan of scans) {
      await runCompetitorMonitor(
        `${scan.label} (proxy recovery)`,
        scan.mode,
        scan.skipIfRecentMinutes,
      );
    }

    if (rpaUiHealthPending) {
      rpaUiHealthPending = false;
      await runRpaUiHealthMonitor("proxy recovery");
    }
  }

  setTimeout(() => {
    void runProxyStatusCheck("startup");
  }, 0);

  setTimeout(() => {
    void runEmailSync("startup");
  }, 250);

  setTimeout(() => {
    void runReservationEndReminders("startup recovery");
  }, 5_000);

  setTimeout(() => {
    void runReservationNotifications("startup");
  }, 15_000);

  setTimeout(() => {
    void runContactPreflight("startup");
  }, 20_000);

  setTimeout(() => {
    void runGooglePeopleSync("startup");
  }, 30_000);

  setTimeout(() => {
    const startupMode = resolveCompetitorStartupMode();
    void runCompetitorMonitor(`startup catch-up (${startupMode})`, startupMode, 120);
  }, 60_000);

  setTimeout(() => {
    void runTailscaleDeviceMonitor("startup");
  }, 40_000);

  setTimeout(() => {
    void runRpaSessionExpiryMonitor("startup catch-up");
  }, 35_000);

  schedule("*/15 * * * * *", async () => {
    await runEmailSync("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runProxyStatusCheck("cron");
  });

  schedule("*/30 * * * * *", async () => {
    await runReservationNotifications("cron");
  });

  schedule("10,40 * * * * *", async () => {
    await runReservationEndReminders("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runContactPreflight("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runGooglePeopleSync("cron");
  });

  schedule("*/5 * * * *", async () => {
    await runTailscaleDeviceMonitor("cron");
  });

  schedule("0 21 * * *", async () => {
    await runRpaSessionExpiryMonitor("21:00 daily warning check");
  }, {
    timezone: "Asia/Seoul",
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
    await runCompetitorMonitor("12:00 today through seven days ahead", "today-plus-seven");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 15 * * *", async () => {
    await runCompetitorMonitor("15:00 today through seven days ahead", "today-plus-seven");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 18 * * *", async () => {
    await runCompetitorMonitor("18:00 today through seven days ahead", "today-plus-seven");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 23 * * *", async () => {
    await runCompetitorMonitor("23:00 tomorrow through month horizon", "night-month-horizon");
  }, {
    timezone: "Asia/Seoul",
  });

  schedule("0 7 1 * *", async () => {
    await runCompetitorMonitor("monthly", "monthly");
  }, {
    timezone: "Asia/Seoul",
  });

  console.log("[Cron] Email auto sync started (15 second interval)");
  console.log("[Cron] Reservation notification monitor started (30 second interval, immediate after email changes, dawn booking enabled, on-time-exit is manual-only)");
  console.log("[Cron] Reservation end reminder monitor started (10 minutes before end, 30 second interval, startup recovery)");
  console.log("[Cron] Reservation contact preflight started (5 minute interval)");
  console.log("[Cron] Google contacts sync started (5 minute interval after account connection)");
  console.log("[Cron] ISP proxy status monitor started (5 minute interval)");
  console.log("[Cron] Naver status reconcile started (10:00/22:00 daily)");
  console.log("[Cron] RPA UI health monitor started (02:20/08:20/14:20/20:20 read-only checks)");
  console.log("[Cron] Tailscale device monitor started (5 minute interval, alert after 15 continuous offline minutes)");
  console.log("[Cron] Naver/SpaceCloud login expiry monitor started (21:00 daily, warnings at 3/2/1 days before expiry)");
  console.log("[Cron] Competitor monitor started (each run: Naver Synergy/Tryground, then Synergy SpaceCloud cross-check; 07:00 today+tomorrow, 12:00/15:00/18:00 today+7 days, 23:00 tomorrow through month-end or next-month day 15 in the final 7 days, monthly baseline at 07:00 on day 1)");
}
