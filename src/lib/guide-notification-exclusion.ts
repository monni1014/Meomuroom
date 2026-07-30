export const MANUAL_GUIDE_EXCLUSION_REASON = "운영자 요청으로 안내문자 발송 제외";

export const EXCLUDABLE_GUIDE_NOTIFICATION_STATUSES = [
  "PENDING",
  "WAITING_CONTACT",
  "WAITING_CONTACT_SYNC",
  "FAILED",
  "DRY_RUN",
] as const;

export function isManualGuideNotificationExclusion(input: {
  notificationStatus: string | null;
  notificationError: string | null;
}) {
  return input.notificationStatus === "SKIPPED"
    && input.notificationError === MANUAL_GUIDE_EXCLUSION_REASON;
}

export function canExcludeGuideNotification(input: {
  notificationStatus: string | null;
  notified: boolean;
  reservationStatus: string;
  hasOutboundReminder: boolean;
}) {
  return input.reservationStatus === "CONFIRMED"
    && !input.notified
    && !input.hasOutboundReminder
    && EXCLUDABLE_GUIDE_NOTIFICATION_STATUSES.includes(
      (input.notificationStatus || "PENDING") as typeof EXCLUDABLE_GUIDE_NOTIFICATION_STATUSES[number],
    );
}
