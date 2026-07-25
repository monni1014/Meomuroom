export const RESERVATION_END_REMINDER_LEAD_MS = 10 * 60 * 1000;

type ReminderContentInput = {
  roomName: string;
  customerName: string | null;
  headCount: number;
};

export function resolveReservationEndReminderHeadCount(input: {
  headCount?: number | null;
  reservedHeadCount?: number | null;
}) {
  return input.headCount || input.reservedHeadCount || 0;
}

export function buildReservationEndReminderContent(input: ReminderContentInput) {
  return {
    title: "예약 종료 알림",
    body: [
      input.roomName || "머무룸",
      input.customerName?.trim() || "이름 미입력",
      input.headCount > 0 ? `${input.headCount}명` : "인원 미입력",
      "종료 10분 전",
    ].join("\n"),
  };
}

export function isReservationEndReminderDue(input: {
  startTime: Date;
  endTime: Date;
  status: string;
  isNoShow: boolean;
}, now = new Date()) {
  return input.status === "CONFIRMED"
    && !input.isNoShow
    && input.startTime <= now
    && input.endTime > now
    && input.endTime.getTime() <= now.getTime() + RESERVATION_END_REMINDER_LEAD_MS;
}
