export async function registerNodeInstrumentation() {
  const g = globalThis as unknown as { __emailSyncCronStarted?: boolean };
  if (g.__emailSyncCronStarted) return;
  g.__emailSyncCronStarted = true;

  const { schedule } = await import("node-cron");
  const { syncEmails } = await import("@/lib/email-sync");
  const { checkIproyalTrafficAndAlert } = await import("@/lib/iproyal-traffic");

  let running = false;
  let proxyTrafficRunning = false;

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

  setTimeout(() => {
    void runEmailSync("startup");
  }, 0);

  setTimeout(() => {
    void runProxyTrafficCheck("startup");
  }, 10_000);

  schedule("*/30 * * * * *", async () => {
    await runEmailSync("cron");
  });

  schedule("*/10 * * * *", async () => {
    await runProxyTrafficCheck("cron");
  });

  console.log("[Cron] Email auto sync started (30 second interval)");
  console.log("[Cron] IPRoyal traffic monitor started (10 minute interval)");
}
