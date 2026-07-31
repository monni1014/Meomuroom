export type CompetitorChangeRange = {
  key: string;
  scanId: string;
  competitorId: string;
  dateKey: string;
  eventType: "BOOKED" | "CANCELLED";
  startHour: number;
  endHour: number;
};

export type CompetitorReschedule = {
  bookedKey: string;
  cancelledKey: string;
  scanId: string;
  competitorId: string;
  dateKey: string;
  oldStartHour: number;
  oldEndHour: number;
  newStartHour: number;
  newEndHour: number;
};

/** Keep raw events for auditing and derive only conservative one-hour moves. */
export function detectSynergyOneHourReschedules(
  ranges: CompetitorChangeRange[],
): CompetitorReschedule[] {
  const bookings = ranges.filter((range) => (
    ["synergy", "synergy-spacecloud"].includes(range.competitorId)
    && range.eventType === "BOOKED"
    && range.endHour - range.startHour === 1
  ));
  const cancellations = ranges.filter((range) => (
    ["synergy", "synergy-spacecloud"].includes(range.competitorId)
    && range.eventType === "CANCELLED"
    && range.endHour - range.startHour === 1
  ));

  const candidates: Array<CompetitorReschedule & { distance: number }> = [];
  for (const booking of bookings) {
    for (const cancellation of cancellations) {
      if (
        booking.scanId !== cancellation.scanId
        || booking.competitorId !== cancellation.competitorId
        || booking.dateKey !== cancellation.dateKey
      ) continue;

      if (booking.endHour <= cancellation.startHour) {
        const duration = cancellation.startHour - booking.startHour;
        if (duration >= 2) {
          candidates.push({
            bookedKey: booking.key,
            cancelledKey: cancellation.key,
            scanId: booking.scanId,
            competitorId: booking.competitorId,
            dateKey: booking.dateKey,
            oldStartHour: booking.endHour,
            oldEndHour: cancellation.endHour,
            newStartHour: booking.startHour,
            newEndHour: cancellation.startHour,
            distance: duration,
          });
        }
        continue;
      }

      if (cancellation.endHour <= booking.startHour) {
        const duration = booking.endHour - cancellation.endHour;
        if (duration >= 2) {
          candidates.push({
            bookedKey: booking.key,
            cancelledKey: cancellation.key,
            scanId: booking.scanId,
            competitorId: booking.competitorId,
            dateKey: booking.dateKey,
            oldStartHour: cancellation.startHour,
            oldEndHour: booking.startHour,
            newStartHour: cancellation.endHour,
            newEndHour: booking.endHour,
            distance: duration,
          });
        }
      }
    }
  }

  candidates.sort((left, right) => left.distance - right.distance);
  const usedBookings = new Set<string>();
  const usedCancellations = new Set<string>();
  const matches: CompetitorReschedule[] = [];
  for (const candidate of candidates) {
    if (usedBookings.has(candidate.bookedKey) || usedCancellations.has(candidate.cancelledKey)) continue;
    usedBookings.add(candidate.bookedKey);
    usedCancellations.add(candidate.cancelledKey);
    matches.push({
      bookedKey: candidate.bookedKey,
      cancelledKey: candidate.cancelledKey,
      scanId: candidate.scanId,
      competitorId: candidate.competitorId,
      dateKey: candidate.dateKey,
      oldStartHour: candidate.oldStartHour,
      oldEndHour: candidate.oldEndHour,
      newStartHour: candidate.newStartHour,
      newEndHour: candidate.newEndHour,
    });
  }
  return matches;
}

export type CompetitorBookingEventForPush = {
  scanId?: string;
  competitorId: string;
  dateKey: string;
  hour: number;
  eventType: string;
  cancellationFeeRate?: number | null;
};

export type SynergyBookingPush = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

function formatHour(hour: number) {
  return `${hour}시`;
}

function formatDate(dateKey: string) {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}월 ${day}일`;
}

export function buildSynergyBookingPushes(
  events: CompetitorBookingEventForPush[],
): SynergyBookingPush[] {
  const synergyEvents = events
    .filter((event) => event.competitorId === "synergy" && ["BOOKED", "CANCELLED"].includes(event.eventType))
    .sort((left, right) => (
      left.dateKey.localeCompare(right.dateKey)
      || left.eventType.localeCompare(right.eventType)
      || left.hour - right.hour
    ));
  const ranges: Array<{
    key: string;
    scanId: string;
    competitorId: string;
    dateKey: string;
    eventType: "BOOKED" | "CANCELLED";
    startHour: number;
    endHour: number;
  }> = [];
  for (const event of synergyEvents) {
    const eventType = event.eventType === "CANCELLED" ? "CANCELLED" : "BOOKED";
    const scanId = event.scanId || "current-scan";
    const previous = ranges.at(-1);
    if (
      previous
      && previous.scanId === scanId
      && previous.dateKey === event.dateKey
      && previous.eventType === eventType
      && (previous.endHour === event.hour || previous.endHour === event.hour + 1)
    ) {
      previous.endHour = Math.max(previous.endHour, event.hour + 1);
      continue;
    }
    ranges.push({
      key: `${scanId}:${event.dateKey}:${eventType}:${event.hour}`,
      scanId,
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      eventType,
      startHour: event.hour,
      endHour: event.hour + 1,
    });
  }

  const reschedules = detectSynergyOneHourReschedules(ranges);
  const matchedBookingKeys = new Set(reschedules.map((match) => match.bookedKey));
  const hoursByDate = new Map<string, Set<number>>();

  for (const range of ranges) {
    if (range.eventType !== "BOOKED" || matchedBookingKeys.has(range.key)) continue;
    const hours = hoursByDate.get(range.dateKey) || new Set<number>();
    for (let hour = range.startHour; hour < range.endHour; hour += 1) hours.add(hour);
    hoursByDate.set(range.dateKey, hours);
  }

  const pushes: SynergyBookingPush[] = reschedules.map((match) => ({
    title: "시너지 예약 시간 변경 추정",
    body: `${formatDate(match.dateKey)} / ${formatHour(match.oldStartHour)}~${formatHour(match.oldEndHour)} → ${formatHour(match.newStartHour)}~${formatHour(match.newEndHour)}`,
    url: `/competitors?year=${match.dateKey.slice(0, 4)}&month=${Number(match.dateKey.slice(5, 7))}`,
    tag: `competitor-synergy-rescheduled-${match.dateKey}-${match.oldStartHour}-${match.oldEndHour}-${match.newStartHour}-${match.newEndHour}`,
  }));
  for (const dateKey of [...hoursByDate.keys()].sort()) {
    const hours = [...(hoursByDate.get(dateKey) || [])].sort((a, b) => a - b);
    if (hours.length === 0) continue;

    let startHour = hours[0];
    let previousHour = hours[0];
    const appendPush = (endHour: number) => {
      pushes.push({
        title: "시너지 신규 예약 발견",
        body: `${formatDate(dateKey)} / ${formatHour(startHour)}~${formatHour(endHour)}`,
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

function groupSpacecloudEvents(events: CompetitorBookingEventForPush[]) {
  const sorted = events
    .filter((event) => (
      event.competitorId === "synergy-spacecloud"
      && ["BOOKED", "CANCELLED"].includes(event.eventType)
    ))
    .sort((left, right) => (
      left.dateKey.localeCompare(right.dateKey)
      || left.eventType.localeCompare(right.eventType)
      || left.hour - right.hour
    ));
  const ranges: CompetitorChangeRange[] = [];
  for (const event of sorted) {
    const eventType = event.eventType === "CANCELLED" ? "CANCELLED" : "BOOKED";
    const scanId = event.scanId || "current-scan";
    const previous = ranges.at(-1);
    if (
      previous
      && previous.scanId === scanId
      && previous.dateKey === event.dateKey
      && previous.eventType === eventType
      && previous.endHour === event.hour
    ) {
      previous.endHour = event.hour + 1;
      continue;
    }
    ranges.push({
      key: `${scanId}:${event.dateKey}:${eventType}:${event.hour}`,
      scanId,
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      eventType,
      startHour: event.hour,
      endHour: event.hour + 1,
    });
  }
  return ranges;
}

export function buildSynergySpacecloudPushes(
  events: CompetitorBookingEventForPush[],
): SynergyBookingPush[] {
  const ranges = groupSpacecloudEvents(events);
  const reschedules = detectSynergyOneHourReschedules(ranges);
  const matchedKeys = new Set(reschedules.flatMap((match) => [match.bookedKey, match.cancelledKey]));
  const eventByHour = new Map(
    events.map((event) => [`${event.scanId || "current-scan"}:${event.dateKey}:${event.eventType}:${event.hour}`, event]),
  );

  const pushes: SynergyBookingPush[] = reschedules.map((match) => ({
    title: "시너지 스클 예약 시간 변경 추정",
    body: `${formatDate(match.dateKey)} / ${formatHour(match.oldStartHour)}~${formatHour(match.oldEndHour)} → ${formatHour(match.newStartHour)}~${formatHour(match.newEndHour)}`,
    url: `/competitors?year=${match.dateKey.slice(0, 4)}&month=${Number(match.dateKey.slice(5, 7))}`,
    tag: `competitor-synergy-spacecloud-rescheduled-${match.dateKey}-${match.oldStartHour}-${match.oldEndHour}-${match.newStartHour}-${match.newEndHour}`,
  }));

  for (const range of ranges) {
    if (matchedKeys.has(range.key)) continue;
    const sourceEvents = [];
    for (let hour = range.startHour; hour < range.endHour; hour += 1) {
      const event = eventByHour.get(`${range.scanId}:${range.dateKey}:${range.eventType}:${hour}`);
      if (event) sourceEvents.push(event);
    }
    const feeRate = sourceEvents.find((event) => event.cancellationFeeRate !== null)?.cancellationFeeRate;
    pushes.push({
      title: range.eventType === "BOOKED" ? "시너지 스클 신규 예약" : "시너지 스클 예약 취소",
      body: range.eventType === "CANCELLED" && feeRate !== null && feeRate !== undefined
        ? `${formatDate(range.dateKey)} / ${formatHour(range.startHour)}~${formatHour(range.endHour)} · 취소수수료 ${feeRate}%`
        : `${formatDate(range.dateKey)} / ${formatHour(range.startHour)}~${formatHour(range.endHour)}`,
      url: `/competitors?year=${range.dateKey.slice(0, 4)}&month=${Number(range.dateKey.slice(5, 7))}`,
      tag: `competitor-synergy-spacecloud-${range.eventType.toLowerCase()}-${range.dateKey}-${range.startHour}-${range.endHour}`,
    });
  }

  return pushes;
}
