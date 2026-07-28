type SpaceCloudBookingPushInput = {
  reservationId: string;
  roomName: string;
  customerName: string | null;
  startTime: Date;
  endTime: Date;
  headCount: number;
  price: number;
};

function kstParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatHourMinute(parts: Record<string, string>) {
  return parts.minute === "00" ? `${Number(parts.hour)}시` : `${Number(parts.hour)}시 ${parts.minute}분`;
}

export function buildSpaceCloudBookingPush(input: SpaceCloudBookingPushInput) {
  const start = kstParts(input.startTime);
  const end = kstParts(input.endTime);
  const dateKey = input.startTime.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  return {
    title: "스클 신규 예약",
    body: `${input.roomName}\n${input.customerName?.trim() || "이름 없음"}\n${Number(start.month)}월 ${Number(start.day)}일 / ${formatHourMinute(start)}~${formatHourMinute(end)}\n인원 ${input.headCount}명 · 매출액 ${input.price.toLocaleString("ko-KR")}원`,
    url: `/calendar?date=${dateKey}`,
    tag: `spacecloud-booking-${input.reservationId}`,
  };
}
