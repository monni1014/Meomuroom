export const RESERVATION_END_REMINDER_LEAD_MS = 10 * 60 * 1000;

export function splitReservationEndReminderGroups<
  T extends { id: string; startTime: Date; endTime: Date },
>(members: T[]) {
  const orderedMembers = [...members].sort((left, right) => (
    left.startTime.getTime() - right.startTime.getTime()
    || left.endTime.getTime() - right.endTime.getTime()
    || left.id.localeCompare(right.id)
  ));
  const groups: T[][] = [];

  for (const member of orderedMembers) {
    const currentGroup = groups.at(-1);
    if (!currentGroup) {
      groups.push([member]);
      continue;
    }

    const currentEndTime = Math.max(
      ...currentGroup.map((item) => item.endTime.getTime()),
    );
    if (member.startTime.getTime() <= currentEndTime) {
      currentGroup.push(member);
    } else {
      groups.push([member]);
    }
  }

  return groups;
}

export function resolveReservationEndReminderGroup<
  T extends { id: string; endTime: Date },
>(members: T[]) {
  const orderedMembers = [...members].sort((left, right) => (
    left.endTime.getTime() - right.endTime.getTime()
    || left.id.localeCompare(right.id)
  ));

  return {
    members: orderedMembers,
    reminder: orderedMembers.at(-1) || null,
  };
}

type ReminderContentInput = {
  roomName: string;
  customerName: string | null;
  headCount: number;
  additionalPeople?: number;
  unpaidExtraAmount?: number;
};

export function resolveReservationEndReminderHeadCount(input: {
  headCount?: number | null;
  reservedHeadCount?: number | null;
}) {
  return input.headCount || input.reservedHeadCount || 0;
}

export function buildReservationEndReminderContent(input: ReminderContentInput) {
  const additionalPeople = Math.max(0, input.additionalPeople || 0);
  const unpaidExtraAmount = Math.max(0, input.unpaidExtraAmount || 0);
  const needsExtraPayment = additionalPeople > 0 || unpaidExtraAmount > 0;

  return {
    title: "예약 종료 알림",
    body: [
      input.roomName || "머무룸",
      input.customerName?.trim() || "이름 미입력",
      input.headCount > 0 ? `${input.headCount}명` : "인원 미입력",
      "종료 10분 전",
      ...(needsExtraPayment
        ? [
            unpaidExtraAmount > 0
              ? `추가금 결제 필요 · ${additionalPeople > 0 ? `추가 인원 ${additionalPeople}명 · ` : ""}${unpaidExtraAmount.toLocaleString("ko-KR")}원`
              : `추가금 확인 필요 · 추가 인원 ${additionalPeople}명`,
          ]
        : []),
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
