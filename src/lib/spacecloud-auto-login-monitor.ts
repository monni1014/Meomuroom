import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { isRpaMaintenanceActive } from "@/lib/rpa-maintenance-lock";
import { isRpaPausedForProxy } from "@/lib/rpa-proxy-circuit";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "rpa/spacecloud-login-auto.mjs";
const ALERT_KEY = "spacecloud-automatic-relogin";

type MonitorGlobal = typeof globalThis & {
  __memoroomSpaceCloudAutoLoginRunning?: boolean;
};

function conciseError(error: unknown) {
  const value = error as { stderr?: string; message?: string };
  return String(value?.stderr || value?.message || error || "알 수 없는 오류")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export async function checkAndRepairSpaceCloudLogin() {
  if (isRpaMaintenanceActive()) return { skipped: true, reason: "memory-optimization" };
  if (isRpaPausedForProxy()) return { skipped: true, reason: "proxy-paused" };

  const g = globalThis as MonitorGlobal;
  if (g.__memoroomSpaceCloudAutoLoginRunning) {
    return { skipped: true, reason: "already-running" };
  }

  g.__memoroomSpaceCloudAutoLoginRunning = true;
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    await resolveAdminAlertByDedupeKey(ALERT_KEY);
    return {
      skipped: false,
      repaired: stdout.includes('"action":"automatic-relogin"'),
    };
  } catch (error) {
    const detail = conciseError(error);
    await createAdminAlert({
      type: "RPA_LOGIN_SESSION",
      severity: "CRITICAL",
      title: "스클 자동 로그인 확인 필요",
      message: `저장된 카카오 로그인 또는 이메일 인증 단계에서 자동 복구하지 못했습니다. ${detail}`,
      dedupeKey: ALERT_KEY,
      repeatAfterMs: 60 * 60 * 1000,
    });
    return { skipped: false, repaired: false, error: detail };
  } finally {
    g.__memoroomSpaceCloudAutoLoginRunning = false;
  }
}
