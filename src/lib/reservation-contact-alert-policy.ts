const AUTOMATED_RESERVATION_SOURCES = new Set(["naver", "spacecloud"]);

export const AUTOMATED_CONTACT_GRACE_MS = 5 * 60 * 1000;

export function hasContactAlertGraceElapsed(
  source: string,
  createdAt: Date,
  now: Date,
) {
  if (!AUTOMATED_RESERVATION_SOURCES.has(source)) return true;
  return now.getTime() - createdAt.getTime() >= AUTOMATED_CONTACT_GRACE_MS;
}
