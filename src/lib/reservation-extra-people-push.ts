const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

type ExtraPeoplePushInput = {
  id: string;
  roomName: string;
  customerName: string | null;
  startTime: Date;
  endTime: Date;
  previousHeadCount: number;
  headCount: number;
  additionalPeople: number;
  unpaidExtraAmount: number;
};

function getKstParts(value: Date) {
  const shifted = new Date(value.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function formatKstClock(value: Date) {
  const parts = getKstParts(value);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function getKstDateKey(value: Date) {
  const parts = getKstParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function resolveAdditionalPeople(input: {
  headCount?: number | null;
  reservedHeadCount?: number | null;
}) {
  return Math.max(0, (input.headCount || 0) - (input.reservedHeadCount || 0));
}

export function buildExtraPeoplePush(input: ExtraPeoplePushInput) {
  const startParts = getKstParts(input.startTime);
  const paymentLine = input.unpaidExtraAmount > 0
    ? `추가금 ${input.unpaidExtraAmount.toLocaleString("ko-KR")}원 결제 필요`
    : "추가금 확인 필요";

  return {
    title: `추가 인원 발생 · ${input.roomName}`,
    body: [
      input.customerName?.trim() || "이름 미입력",
      `${startParts.month}월 ${startParts.day}일 ${formatKstClock(input.startTime)}~${formatKstClock(input.endTime)}`,
      `실제 인원 ${input.previousHeadCount}명 → ${input.headCount}명 (추가 ${input.additionalPeople}명)`,
      paymentLine,
    ].join("\n"),
    url: `/calendar?date=${getKstDateKey(input.startTime)}`,
    tag: `reservation-extra-people-${input.id}-${input.headCount}`,
  };
}
