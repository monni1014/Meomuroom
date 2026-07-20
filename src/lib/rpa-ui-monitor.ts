import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyRpaFailure } from "@/lib/rpa-failure-classifier";
import { reportRpaScriptFailure, resolveRpaScriptAlerts } from "@/lib/rpa-ui-alerts";

const execFileAsync = promisify(execFile);

type RpaHealthPlatform = "naver" | "spacecloud";

type RpaUiMonitorGlobal = typeof globalThis & {
  __memoroomRpaUiMonitorRunning?: boolean;
};

const NAVER_HEALTH_SCRIPT = "rpa/naver-toggle-slots.mjs";
const SPACECLOUD_HEALTH_SCRIPT = "rpa/spacecloud-external-reservation.mjs";
const NAVER_ROOM1_PRODUCT_URL = "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail";

function tomorrowKstDate() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function monitorEnv() {
  return {
    ...process.env,
    RPA_DELAY_MULTIPLIER: "0.35",
    RPA_MIN_RANDOM_DELAY_FLOOR_MS: "200",
    RPA_LOCK_RETRY_MIN_MS: "250",
    RPA_LOCK_RETRY_MAX_MS: "500",
  };
}

async function executeHealthScript(platform: RpaHealthPlatform) {
  const dateValue = tomorrowKstDate();
  const scriptPath = platform === "naver" ? NAVER_HEALTH_SCRIPT : SPACECLOUD_HEALTH_SCRIPT;
  const args = platform === "naver"
    ? [
        scriptPath,
        "--room=1",
        `--date=${dateValue}`,
        "--start=12:00",
        "--end=13:00",
        "--mode=close",
        `--product-url=${NAVER_ROOM1_PRODUCT_URL}`,
        "--health-check",
      ]
    : [
        scriptPath,
        "--room=1",
        `--date=${dateValue}`,
        "--start=12:00",
        "--end=13:00",
        "--mode=close",
        "--booking-number=MEMOROOM-HEALTH-CHECK",
        "--health-check",
      ];

  const command = platform === "spacecloud" && process.platform === "linux"
    ? "xvfb-run"
    : process.execPath;
  const commandArgs = command === "xvfb-run"
    ? ["-a", process.execPath, ...args]
    : args;

  try {
    await execFileAsync(command, commandArgs, {
      cwd: process.cwd(),
      env: monitorEnv(),
      timeout: platform === "spacecloud" ? 240_000 : 180_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    await resolveRpaScriptAlerts(scriptPath).catch((error) => {
      console.error(`[RPA health] Could not resolve ${platform} alert:`, error);
    });
    console.log(`[RPA health] ${platform} UI contract is healthy.`);
    return { platform, status: "HEALTHY" as const };
  } catch (error) {
    const kind = classifyRpaFailure(error);
    if (kind === "BUSY") {
      console.log(`[RPA health] ${platform} check skipped because another RPA task owns the lock.`);
      return { platform, status: "SKIPPED_BUSY" as const };
    }

    await reportRpaScriptFailure(error, scriptPath).catch((alertError) => {
      console.error(`[RPA health] Could not create ${platform} alert:`, alertError);
    });
    console.error(`[RPA health] ${platform} UI contract check failed (${kind}).`);
    return { platform, status: "FAILED" as const, kind };
  }
}

export async function runRpaUiHealthChecks() {
  const g = globalThis as RpaUiMonitorGlobal;
  if (g.__memoroomRpaUiMonitorRunning) {
    return { skipped: true, reason: "already-running", results: [] };
  }

  g.__memoroomRpaUiMonitorRunning = true;
  try {
    const results = [];
    for (const platform of ["naver", "spacecloud"] as const) {
      results.push(await executeHealthScript(platform));
    }
    return { skipped: false, results };
  } finally {
    g.__memoroomRpaUiMonitorRunning = false;
  }
}
