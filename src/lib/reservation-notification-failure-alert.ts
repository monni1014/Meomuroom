type ReservationFailureAlertInput = {
  roomName: string | null;
  customerName: string | null;
  startTime: Date;
  endTime: Date;
  error?: string | null;
};

function kstParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatReservationTime(startTime: Date, endTime: Date) {
  const start = kstParts(startTime);
  const end = kstParts(endTime);
  const startDate = `${Number(start.month)}월 ${Number(start.day)}일`;
  const startClock = `${start.hour}:${start.minute}`;
  const endClock = `${end.hour}:${end.minute}`;
  const sameDate = start.month === end.month && start.day === end.day;
  const endLabel = sameDate
    ? endClock
    : `${Number(end.month)}월 ${Number(end.day)}일 ${endClock}`;
  return `${startDate} ${startClock}~${endLabel}`;
}

export function buildReservationNotificationFailureAlert(input: ReservationFailureAlertInput) {
  const roomName = input.roomName?.trim() || "방 정보 없음";
  const customerName = input.customerName?.trim() || "이름 없음";
  const reason = input.error?.trim() || "문자 수신 실패";
  return {
    title: "문자 수신 실패",
    message: `${roomName}\n${customerName} · ${formatReservationTime(input.startTime, input.endTime)} 예약\n사유: ${reason}`,
  };
}
