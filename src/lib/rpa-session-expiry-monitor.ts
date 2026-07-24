import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAdminAlert } from "@/lib/admin-alerts";
import { prisma } from "@/lib/prisma";
import {
  remainingKstCalendarDays,
  sessionExpiryAlertKey,
  sessionExpiryAlertPrefix,
  sessionExpiryWarningDay,
  type RpaSessionPlatform,
} from "@/lib/rpa-session-expiry-policy";

const execFileAsync = promisify(execFile);
const INSPECT_SCRIPT = "scripts/inspect-rpa-session-expiry.mjs";

type SessionInspection = {
  platform: RpaSessionPlatform;
  source: "live-browser" | "storage-state";
  cookieName: string | null;
  expiresAt: string | null;
};

type InspectionPayload = {
  sessions?: SessionInspection[];
};

const PLATFORM_LABELS: Record<RpaSessionPlatform, string> = {
  naver: "네이버",
  spacecloud: "스클",
};

function formatExpiryKst(expiresAtMs: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(expiresAtMs));
}

async function inspectSessions() {
  const { stdout } = await execFileAsync(process.execPath, [INSPECT_SCRIPT], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as InspectionPayload;
}

async function resolveOtherExpiryWarnings(platform: RpaSessionPlatform, keepKey?: string) {
  await prisma.adminAlert.updateMany({
    where: {
      type: "RPA_LOGIN_EXPIRY_WARNING",
      resolved: false,
      dedupeKey: {
        startsWith: sessionExpiryAlertPrefix(platform),
        ...(keepKey ? { not: keepKey } : {}),
      },
    },
    data: { resolved: true },
  });
}

export async function checkRpaSessionExpiryWarnings(nowMs = Date.now()) {
  const payload = await inspectSessions();
  const results = [];

  for (const platform of ["naver", "spacecloud"] as const) {
    const session = payload.sessions?.find((item) => item.platform === platform);
    const expiresAtMs = session?.expiresAt ? new Date(session.expiresAt).getTime() : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) {
      results.push({ platform, status: "UNKNOWN" as const });
      continue;
    }

    const remainingDays = remainingKstCalendarDays(expiresAtMs, nowMs);
    const warningDay = sessionExpiryWarningDay(expiresAtMs, nowMs);
    if (warningDay === null) {
      if (remainingDays > 3) await resolveOtherExpiryWarnings(platform);
      results.push({
        platform,
        status: remainingDays <= 0 ? "EXPIRED" as const : "HEALTHY" as const,
        remainingDays,
        expiresAt: session?.expiresAt,
      });
      continue;
    }

    const dedupeKey = sessionExpiryAlertKey(platform, expiresAtMs, warningDay);
    await resolveOtherExpiryWarnings(platform, dedupeKey);
    await createAdminAlert({
      type: "RPA_LOGIN_EXPIRY_WARNING",
      severity: "WARNING",
      title: `${PLATFORM_LABELS[platform]} 로그인 만료 ${warningDay}일 전`,
      message: `${PLATFORM_LABELS[platform]} 로그인 세션이 ${formatExpiryKst(expiresAtMs)}에 만료됩니다. 만료 전에 재로그인해 주세요.`,
      dedupeKey,
    });
    results.push({
      platform,
      status: "WARNING" as const,
      remainingDays: warningDay,
      expiresAt: session?.expiresAt,
    });
  }

  return { results };
}
