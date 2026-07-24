const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAWN_BOOKING_START_MINUTES = 60;
export const DAWN_BOOKING_END_MINUTES = 7 * 60;

export function isDawnBookingStart(startTime: Date) {
  const shifted = new Date(startTime.getTime() + KST_OFFSET_MS);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return minutes >= DAWN_BOOKING_START_MINUTES && minutes <= DAWN_BOOKING_END_MINUTES;
}

export function dawnBookingAutoSendStartsAt(
  value = process.env.SOLAPI_DAWN_AUTO_SEND_START_AT,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return null;

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

