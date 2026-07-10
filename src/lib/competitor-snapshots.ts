import "server-only";
import { prisma } from "@/lib/prisma";

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

type CancellationEvent = {
  scanId: string;
  competitorId: string;
  dateKey: string;
  hour: number;
  cancellationFeeRate: number | null;
  occurredAt: Date;
};

function groupCancellationEvents(events: CancellationEvent[]) {
  const groups: Array<{
    scanId: string;
    competitorId: string;
    dateKey: string;
    startHour: number;
    endHour: number;
    feeRate: number | null;
    occurredAt: string;
  }> = [];

  for (const event of events) {
    const previous = groups.at(-1);
    if (
      previous
      && previous.scanId === event.scanId
      && previous.competitorId === event.competitorId
      && previous.dateKey === event.dateKey
      && previous.endHour === event.hour
      && previous.feeRate === event.cancellationFeeRate
    ) {
      previous.endHour = event.hour + 1;
      continue;
    }
    groups.push({
      scanId: event.scanId,
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      startHour: event.hour,
      endHour: event.hour + 1,
      feeRate: event.cancellationFeeRate,
      occurredAt: event.occurredAt.toISOString(),
    });
  }
  return groups;
}

export async function getCompetitorSnapshots(year: number, month: number) {
  const { startKey, endKey } = monthRange(year, month);
  const [slots, cancellationEvents, latestScan] = await Promise.all([
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
        dateKey: { gte: startKey, lte: endKey },
        eventType: "CANCELLED",
      },
      orderBy: [{ occurredAt: "asc" }, { competitorId: "asc" }, { dateKey: "asc" }, { hour: "asc" }],
      select: {
        scanId: true,
        competitorId: true,
        dateKey: true,
        hour: true,
        cancellationFeeRate: true,
        occurredAt: true,
      },
    }),
    prisma.competitorScan.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  const days: Record<string, Record<string, {
    checkedAt: string | null;
    slots: Record<string, {
      state: string;
      opportunityLostRooms: string[];
      cancellationPending: boolean;
      bookingNumber: number | null;
      bookingGroup: string | null;
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

      segments.forEach((segment, segmentIndex) => {
        const opportunityLostRooms = competitorId === "synergy"
          ? ["머무룸1", "머무룸2"].filter((roomName) => {
              for (let hour = segment.startHour; hour <= segment.endHour; hour += 1) {
                if (!day.slots[String(hour)].opportunityLostRooms.includes(roomName)) return false;
              }
              return true;
            })
          : [];

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

  return {
    days,
    cancellations: groupCancellationEvents(cancellationEvents).map((event) => ({
      competitorId: event.competitorId,
      dateKey: event.dateKey,
      startHour: event.startHour,
      endHour: event.endHour,
      feeRate: event.feeRate,
      occurredAt: event.occurredAt,
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
