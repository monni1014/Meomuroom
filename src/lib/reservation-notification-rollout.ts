export function reservationNotificationRolloutStartsAt(
  value = process.env.SOLAPI_RESERVATION_AUTO_SEND_START_AT,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return null;

  const startsAt = Date.parse(normalized);
  return Number.isFinite(startsAt) ? new Date(startsAt) : null;
}

export function isReservationAutoSendActive(
  now = new Date(),
  value = process.env.SOLAPI_RESERVATION_AUTO_SEND_START_AT,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return true;

  const startsAt = reservationNotificationRolloutStartsAt(normalized);
  if (!startsAt) return false;
  return now.getTime() >= startsAt.getTime();
}
