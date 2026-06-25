// Runs once when the Next.js server starts. Used for server-side email sync.
export async function register() {
  // IMAP and Prisma are Node-only. Do not run this in the Edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Prevent duplicate cron registration during dev reloads.
  const g = globalThis as unknown as { __emailSyncCronStarted?: boolean };
  if (g.__emailSyncCronStarted) return;
  g.__emailSyncCronStarted = true;

  const { schedule } = await import("node-cron");
  const { syncEmails } = await import("@/lib/email-sync");

  let running = false;

  // Every 30 seconds. The lock below prevents overlap while RPA/email sync is still running.
  schedule("*/30 * * * * *", async () => {
    if (running) {
      console.log("[Cron] Previous email sync is still running. Skipping this tick.");
      return;
    }

    running = true;
    try {
      const result = await syncEmails();
      console.log(
        `[Cron] Email sync done: checked ${result.processed}, changed ${result.newReservations}`
      );
    } catch (error) {
      console.error("[Cron] Email sync failed:", error);
    } finally {
      running = false;
    }
  });

  console.log("[Cron] Email auto sync started (30 second interval)");
}
