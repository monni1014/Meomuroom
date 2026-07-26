export type CompetitorBookingEventForPush = {
  competitorId: string;
  dateKey: string;
  hour: number;
  eventType: string;
};

export type SynergyBookingPush = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDate(dateKey: string) {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}월 ${day}일`;
}

export function buildSynergyBookingPushes(
  events: CompetitorBookingEventForPush[],
): SynergyBookingPush[] {
  const hoursByDate = new Map<string, Set<number>>();

  for (const event of events) {
    if (event.competitorId !== "synergy" || event.eventType !== "BOOKED") continue;
    const hours = hoursByDate.get(event.dateKey) || new Set<number>();
    hours.add(event.hour);
    hoursByDate.set(event.dateKey, hours);
  }

  const pushes: SynergyBookingPush[] = [];
  for (const dateKey of [...hoursByDate.keys()].sort()) {
    const hours = [...(hoursByDate.get(dateKey) || [])].sort((a, b) => a - b);
    if (hours.length === 0) continue;

    let startHour = hours[0];
    let previousHour = hours[0];
    const appendPush = (endHour: number) => {
      pushes.push({
        title: "시너지 신규 예약 발견",
        body: `${formatDate(dateKey)} ${formatHour(startHour)}~${formatHour(endHour)}`,
        url: `/competitors?year=${dateKey.slice(0, 4)}&month=${Number(dateKey.slice(5, 7))}`,
        tag: `competitor-synergy-booked-${dateKey}-${startHour}-${endHour}`,
      });
    };

    for (const hour of hours.slice(1)) {
      if (hour === previousHour + 1) {
        previousHour = hour;
        continue;
      }
      appendPush(previousHour + 1);
      startHour = hour;
      previousHour = hour;
    }
    appendPush(previousHour + 1);
  }

  return pushes;
}
