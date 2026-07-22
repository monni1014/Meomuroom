export type NotificationResendField = "phone" | "startTime" | "endTime" | "roomName";

const SENT_NOTIFICATION_STATUSES = new Set([
  "SENT",
  "SENDING",
  "SUBMITTED",
  "CARRIER_ACCEPTED",
  "DELIVERED",
  "RECOVERING",
]);

type NotificationSnapshot = {
  phone: string | null;
  startTime: Date;
  endTime: Date;
  roomName: string;
  status: string;
  notified: boolean;
  notificationStatus: string | null;
};

function normalizedPhone(value: string | null) {
  return String(value || "").replace(/\D/g, "");
}

function wasActuallySubmitted(snapshot: NotificationSnapshot) {
  if (SENT_NOTIFICATION_STATUSES.has(snapshot.notificationStatus || "")) return true;
  return snapshot.notified && !["DRY_RUN", "FAILED"].includes(snapshot.notificationStatus || "");
}

export function reservationNotificationEditPolicy(input: {
  existing: NotificationSnapshot;
  next: NotificationSnapshot;
  now?: Date;
}) {
  const changedFields: NotificationResendField[] = [];
  if (normalizedPhone(input.existing.phone) !== normalizedPhone(input.next.phone)) changedFields.push("phone");
  if (input.existing.startTime.getTime() !== input.next.startTime.getTime()) changedFields.push("startTime");
  if (input.existing.endTime.getTime() !== input.next.endTime.getTime()) changedFields.push("endTime");
  if (input.existing.roomName !== input.next.roomName) changedFields.push("roomName");

  const now = input.now || new Date();
  const canSendLater = input.next.status === "CONFIRMED" && input.next.startTime.getTime() > now.getTime();
  const alreadySubmitted = wasActuallySubmitted(input.existing);
  const hasRelevantChanges = changedFields.length > 0;

  return {
    changedFields,
    hasRelevantChanges,
    requiresConfirmation: hasRelevantChanges && canSendLater && alreadySubmitted,
    shouldResetAutomatically: hasRelevantChanges && canSendLater && !alreadySubmitted,
  };
}
