export function buildMemoroomContactName(input: {
  roomName: string;
  startTime: Date;
  customerName: string | null;
}) {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
  }).formatToParts(input.startTime);
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  const roomName = input.roomName.replace(/\s+/g, "").trim() || "머무룸";
  const customerName = input.customerName?.trim() || "이름없음";
  return `${roomName} ${month}/${day} ${customerName}`;
}

export function chooseReservationForContact<T extends { startTime: Date; endTime: Date }>(
  reservations: T[],
  now: Date,
) {
  const activeOrUpcoming = reservations
    .filter((reservation) => reservation.endTime.getTime() >= now.getTime())
    .sort((left, right) => left.startTime.getTime() - right.startTime.getTime());
  if (activeOrUpcoming[0]) return activeOrUpcoming[0];

  return [...reservations].sort(
    (left, right) => right.endTime.getTime() - left.endTime.getTime(),
  )[0] || null;
}
