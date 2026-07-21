import "server-only";
import { prisma } from "@/lib/prisma";
import { shouldDisplayZeroFeeCancellationAsNew } from "@/lib/competitor-cancellation";

const COMPETITOR_IDS = ["synergy", "triground-a", "triground-b"] as const;

function monthRange(year: number, month: number) {
  if (year < 2025 || year > 2100 || month < 1 || month > 12) throw new Error("Invalid year or month");
  const startKey = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startKey,
    endKey: `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
  };
}

function clientState(state: string) {
  if (state === "AVAILABLE") return "available";
  if (state === "BOOKED") return "closed";
  if (state === "POLICY_CLOSED") return "policy_closed";
  if (state === "UNKNOWN") return "need_check";
  return "not_collected";
}

type SlotEvent = {
  id: string;
  scanId: string;
  competitorId: string;
  dateKey: string;
  hour: number;
  eventType: string;
  cancellationFeeRate: number | null;
  occurredAt: Date;
  acknowledgedAt: Date | null;
};

function groupSlotEvents(events: SlotEvent[]) {
  const groups: Array<{
    id: string;
    eventIds: string[];
    scanId: string;
    competitorId: string;
    dateKey: string;
    eventType: string;
    startHour: number;
    endHour: number;
    feeRate: number | null;
    occurredAt: string;
    acknowledged: boolean;
  }> = [];

  for (const event of events) {
    const previous = groups.at(-1);
    if (
      previous
      && previous.scanId === event.scanId
      && previous.competitorId === event.competitorId
      && previous.dateKey === event.dateKey
      && previous.eventType === event.eventType
      && previous.endHour === event.hour
      && previous.feeRate === event.cancellationFeeRate
    ) {
      previous.endHour = event.hour + 1;
      previous.eventIds.push(event.id);
      previous.acknowledged = previous.acknowledged && Boolean(event.acknowledgedAt);
      continue;
    }
    groups.push({
      id: event.id,
      eventIds: [event.id],
      scanId: event.scanId,
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      eventType: event.eventType === "CANCELLED" ? "CANCELLED" as const : "BOOKED" as const,
      startHour: event.hour,
      endHour: event.hour + 1,
      feeRate: event.cancellationFeeRate,
      occurredAt: event.occurredAt.toISOString(),
      acknowledged: Boolean(event.acknowledgedAt),
    });
  }
  return groups;
}

export async function getCompetitorSnapshots(year: number, month: number) {
  const { startKey, endKey } = monthRange(year, month);
  const [slots, slotEvents, latestScan, evidence] = await Promise.all([
    prisma.competitorSlot.findMany({
      where: {
        competitorId: { in: [...COMPETITOR_IDS] },
        dateKey: { gte: startKey, lte: endKey },
        hour: { gte: 8, lt: 24 },
      },
      orderBy: [{ competitorId: "asc" }, { dateKey: "asc" }, { hour: "asc" }],
    }),
    prisma.competitorSlotEvent.findMany({
      where: {
        competitorId: { in: [...COMPETITOR_IDS] },
        eventType: { in: ["BOOKED", "CANCELLED"] },
        OR: [
          { dateKey: { gte: startKey, lte: endKey } },
          { acknowledgedAt: null },
        ],
      },
      orderBy: [{ occurredAt: "asc" }, { competitorId: "asc" }, { dateKey: "asc" }, { hour: "asc" }],
      select: {
        id: true,
        scanId: true,
        competitorId: true,
        dateKey: true,
        hour: true,
        eventType: true,
        cancellationFeeRate: true,
        occurredAt: true,
        acknowledgedAt: true,
      },
    }),
    prisma.competitorScan.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.competitorEvidence.findMany({
      where: {
        dismissedAt: null,
        OR: [
          { dateKey: { gte: startKey, lte: endKey } },
          { dateKey: null, status: "OPEN" },
        ],
      },
      orderBy: [{ status: "asc" }, { capturedAt: "desc" }],
      take: 12,
      select: {
        id: true,
        competitorId: true,
        dateKey: true,
        startHour: true,
        endHour: true,
        reasonCode: true,
        reason: true,
        status: true,
        capturedAt: true,
        lastSeenAt: true,
      },
    }),
  ]);

  const days: Record<string, Record<string, {
    checkedAt: string | null;
    slots: Record<string, {
      state: string;
      opportunityLostRooms: string[];
      cancellationPending: boolean;
      bookingNumber: number | null;
      bookingGroup: string | null;
      firstDetectedAt: string | null;
    }>;
  }>> = {};
  const bookingGroupKeys = new Map<string, string>();
  for (const competitorId of COMPETITOR_IDS) days[competitorId] = {};

  for (const slot of slots) {
    const competitorDays = days[slot.competitorId] || (days[slot.competitorId] = {});
    const day = competitorDays[slot.dateKey] || (competitorDays[slot.dateKey] = { checkedAt: null, slots: {} });
    if (!day.checkedAt || new Date(day.checkedAt) < slot.lastCheckedAt) day.checkedAt = slot.lastCheckedAt.toISOString();
    day.slots[String(slot.hour)] = {
      state: clientState(slot.state),
      opportunityLostRooms: slot.opportunityLostRooms?.split(",").filter(Boolean) || [],
      cancellationPending: slot.pendingState === "AVAILABLE",
      bookingNumber: null,
      bookingGroup: null,
      // A baseline that was already closed is a useful occupancy snapshot, but
      // only AVAILABLE -> BOOKED is a confirmed first-detection event.
      firstDetectedAt: slot.lastBookedAt?.toISOString() || null,
    };
    bookingGroupKeys.set(
      `${slot.competitorId}|${slot.dateKey}|${slot.hour}`,
      slot.lastBookedAt?.toISOString() || "baseline",
    );
  }

  for (const [competitorId, competitorDays] of Object.entries(days)) {
    for (const [dateKey, day] of Object.entries(competitorDays)) {
      const bookedHours = Object.entries(day.slots)
        .filter(([, slot]) => slot.state === "closed")
        .map(([hour]) => Number(hour))
        .sort((left, right) => left - right);
      const segments: Array<{ startHour: number; endHour: number; groupKey: string }> = [];

      for (const hour of bookedHours) {
        const groupKey = bookingGroupKeys.get(`${competitorId}|${dateKey}|${hour}`) || "baseline";
        const previous = segments.at(-1);
        if (!previous || hour !== previous.endHour + 1 || groupKey !== previous.groupKey) {
          segments.push({ startHour: hour, endHour: hour, groupKey });
        } else {
          previous.endHour = hour;
        }
      }

      // 시너지는 최소 예약 시간이 2시간이다. 기존 예약에 나중에 붙은
      // 1시간 구간은 독립 예약이 될 수 없으므로 기존 예약의 연장으로 묶는다.
      if (competitorId === "synergy") {
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index];
          if (segment.endHour - segment.startHour + 1 !== 1) continue;

          const previous = segments[index - 1];
          if (previous && previous.endHour + 1 === segment.startHour) {
            previous.endHour = segment.endHour;
            segments.splice(index, 1);
            index -= 1;
            continue;
          }

          const next = segments[index + 1];
          if (next && segment.endHour + 1 === next.startHour) {
            next.startHour = segment.startHour;
            segments.splice(index, 1);
            index -= 1;
          }
        }
      }

      segments.forEach((segment, segmentIndex) => {
        const duration = segment.endHour - segment.startHour + 1;
        const ignoreOneHourTriground = competitorId.startsWith("triground-") && duration < 2;
        const opportunityLostRooms = ignoreOneHourTriground
          ? []
          : ["머무룸1", "머무룸2"].filter((roomName) => {
              for (let hour = segment.startHour; hour <= segment.endHour; hour += 1) {
                if (!day.slots[String(hour)].opportunityLostRooms.includes(roomName)) return false;
              }
              return true;
            });

        for (let hour = segment.startHour; hour <= segment.endHour; hour += 1) {
          const slot = day.slots[String(hour)];
          slot.bookingGroup = `${dateKey}:${segmentIndex + 1}`;
          slot.opportunityLostRooms = [];
        }

        // A customer chooses one competitor reservation block, not separate
        // hourly slots. Mark a lost room once, and only when that room was
        // available for the entire competitor reservation.
        day.slots[String(segment.startHour)].opportunityLostRooms = opportunityLostRooms;
      });

      for (let index = 0; index < segments.length;) {
        const adjacentSegments = [segments[index]];
        let cursor = index + 1;
        while (
          cursor < segments.length
          && segments[cursor].startHour === adjacentSegments.at(-1)!.endHour + 1
        ) {
          adjacentSegments.push(segments[cursor]);
          cursor += 1;
        }

        if (adjacentSegments.length > 1) {
          adjacentSegments.forEach((segment, sequence) => {
            day.slots[String(segment.startHour)].bookingNumber = sequence + 1;
          });
        }
        index = cursor;
      }
    }
  }

  const groupedEvents = groupSlotEvents(slotEvents);
  const unreadGroups = groupedEvents.filter((event) => !event.acknowledged);
  const supersededBookingIds = new Set<string>();
  const unreadEvents = unreadGroups.map((event) => {
    if (event.eventType !== "CANCELLED") return event;

    const matchingBookings = unreadGroups.filter((candidate) => (
      candidate.eventType === "BOOKED"
      && candidate.competitorId === event.competitorId
      && candidate.dateKey === event.dateKey
      && candidate.startHour === event.startHour
      && candidate.endHour === event.endHour
      && candidate.occurredAt < event.occurredAt
    ));
    matchingBookings.forEach((booking) => booking.eventIds.forEach((id) => supersededBookingIds.add(id)));
    return {
      ...event,
      eventIds: [...event.eventIds, ...matchingBookings.flatMap((booking) => booking.eventIds)],
    };
  })
    .filter((event) => !event.eventIds.every((id) => supersededBookingIds.has(id)))
    .filter((event) => (
      event.eventType !== "CANCELLED"
      || event.feeRate !== 0
      || shouldDisplayZeroFeeCancellationAsNew(
        event.competitorId,
        event.endHour - event.startHour,
        event.feeRate,
      )
    ));

  return {
    days,
    cancellations: groupedEvents.filter((event) => (
      event.eventType === "CANCELLED"
      && event.feeRate !== 0
      && event.dateKey >= startKey
      && event.dateKey <= endKey
    )).map((event) => ({
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      startHour: event.startHour,
      endHour: event.endHour,
      feeRate: event.feeRate,
      occurredAt: event.occurredAt,
    })),
    unreadEvents: unreadEvents.map((event) => ({
      id: event.id,
      eventIds: event.eventIds,
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      eventType: event.eventType === "CANCELLED" ? "CANCELLED" as const : "BOOKED" as const,
      startHour: event.startHour,
      endHour: event.endHour,
      occurredAt: event.occurredAt,
    })),
    evidence: evidence.map((item) => ({
      id: item.id,
      competitorId: item.competitorId,
      dateKey: item.dateKey,
      startHour: item.startHour,
      endHour: item.endHour,
      reasonCode: item.reasonCode,
      reason: item.reason,
      status: item.status,
      capturedAt: item.capturedAt.toISOString(),
      lastSeenAt: item.lastSeenAt.toISOString(),
      imageUrl: `/api/competitors/evidence/${item.id}/image`,
    })),
    latestScan: latestScan
      ? {
          id: latestScan.id,
          mode: latestScan.mode,
          status: latestScan.status,
          checkedSlots: latestScan.checkedSlots,
          changedSlots: latestScan.changedSlots,
          error: latestScan.error,
          startedAt: latestScan.startedAt.toISOString(),
          finishedAt: latestScan.finishedAt?.toISOString() || null,
        }
      : null,
  };
}

export type CompetitorSnapshotPayload = Awaited<ReturnType<typeof getCompetitorSnapshots>>;
