const readinessUrl = process.env.MEMOROOM_RPA_IDLE_URL
  || "http://127.0.0.1:3000/api/internal/rpa-idle";
const maxWaitMs = Number(process.env.MEMOROOM_RPA_DRAIN_TIMEOUT_MS || 13 * 60 * 1000);
const pollMs = Number(process.env.MEMOROOM_RPA_DRAIN_POLL_MS || 2_000);
const requestTimeoutMs = 3_000;
const deadline = Date.now() + maxWaitMs;
let unavailableCount = 0;
let lastReasons = "";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readReadiness() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(readinessUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

console.log("[SafeRestart] Waiting for reservation RPA and competitor scans to become idle.");
while (Date.now() < deadline) {
  try {
    const readiness = await readReadiness();
    unavailableCount = 0;
    if (readiness.idle) {
      console.log("[SafeRestart] RPA is idle. Planned service stop may continue.");
      process.exit(0);
    }
    const reasons = Array.isArray(readiness.reasons) ? readiness.reasons.join(",") : "unknown";
    if (reasons !== lastReasons) {
      console.log(`[SafeRestart] Active work detected: ${reasons}`);
      lastReasons = reasons;
    }
  } catch (error) {
    unavailableCount += 1;
    console.warn(
      `[SafeRestart] Readiness endpoint unavailable (${unavailableCount}/3):`,
      error instanceof Error ? error.message : String(error),
    );
    // An unresponsive app must be allowed to restart for recovery.
    if (unavailableCount >= 3) {
      console.warn("[SafeRestart] App is unavailable; bypass the drain wait and allow recovery restart.");
      process.exit(0);
    }
  }
  await delay(pollMs);
}

console.warn("[SafeRestart] Drain timeout reached. Recovery logic will replay unfinished persistent work after restart.");
process.exit(0);
