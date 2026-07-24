export type RpaSessionPlatform = "naver" | "spacecloud";

export const SESSION_EXPIRY_WARNING_DAYS = [3, 2, 1] as const;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function kstDaySerial(valueMs: number) {
  const shifted = new Date(valueMs + KST_OFFSET_MS);
  return Math.floor(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) / DAY_MS);
}

export function remainingKstCalendarDays(expiresAtMs: number, nowMs = Date.now()) {
  return kstDaySerial(expiresAtMs) - kstDaySerial(nowMs);
}

export function sessionExpiryWarningDay(expiresAtMs: number, nowMs = Date.now()) {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  const remainingDays = remainingKstCalendarDays(expiresAtMs, nowMs);
  return SESSION_EXPIRY_WARNING_DAYS.includes(
    remainingDays as (typeof SESSION_EXPIRY_WARNING_DAYS)[number],
  ) ? remainingDays : null;
}

export function expiryDateKeyKst(expiresAtMs: number) {
  const shifted = new Date(expiresAtMs + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sessionExpiryAlertPrefix(platform: RpaSessionPlatform) {
  return `rpa-login-expiry:${platform}:`;
}

export function sessionExpiryAlertKey(
  platform: RpaSessionPlatform,
  expiresAtMs: number,
  remainingDays: number,
) {
  return `${sessionExpiryAlertPrefix(platform)}${expiryDateKeyKst(expiresAtMs)}:${remainingDays}`;
}
