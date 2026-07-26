const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

type ManualReservationPushInput = {
  id: string;
  roomName: string;
  customerName: string | null;
  startTime: Date;
  endTime: Date;
};

function getPushKstParts(value: Date) {
  const shifted = new Date(value.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function getPushKstDateKey(value: Date) {
  const parts = getPushKstParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatKstClock(value: Date) {
  const parts = getPushKstParts(value);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function buildManualReservationPush(input: ManualReservationPushInput) {
  const startParts = getPushKstParts(input.startTime);
  return {
    title: "수기 예약 추가",
    body: [
      input.roomName,
      input.customerName?.trim() || "이름 미입력",
      `${startParts.month}월 ${startParts.day}일 ${formatKstClock(input.startTime)}~${formatKstClock(input.endTime)}`,
    ].join("\n"),
    url: `/calendar?date=${getPushKstDateKey(input.startTime)}`,
    tag: `manual-reservation-${input.id}`,
  };
}
