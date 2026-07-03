export async function registerNodeInstrumentation() {
  const g = globalThis as unknown as { __emailSyncCronStarted?: boolean };
  if (g.__emailSyncCronStarted) return;
  g.__emailSyncCronStarted = true;

  const { schedule } = await import("node-cron");
  const { syncEmails } = await import("@/lib/email-sync");

  let running = false;

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

  setTimeout(() => {
    void runEmailSync("startup");
  }, 0);

  schedule("*/30 * * * * *", async () => {
    await runEmailSync("cron");
  });

  console.log("[Cron] Email auto sync started (30 second interval)");
}
