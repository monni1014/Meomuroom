import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAdminAlert, resolveAdminAlertsByType } from "@/lib/admin-alerts";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const ALERT_TYPE = "COMPETITOR_MONITOR";

export type CompetitorScanMode =
  | "today"
  | "today-next"
  | "next-week"
  | "daily"
  | "weekly"
  | "monthly"
  | "range";

type ScannerObservation = {
  competitorId: string;
  dateKey: string;
  hour: number;
  observedState: "AVAILABLE" | "BOOKED" | "POLICY_CLOSED" | "UNKNOWN" | "NOT_OFFERED";
  reason: string | null;
  checkedAt: string;
};

type ScannerResult = {
  startKey: string;
  endKey: string;
  observations: ScannerObservation[];
  errors: Array<{ competitorId: string; message: string }>;
};

type RunOptions = {
  mode: CompetitorScanMode;
  startKey?: string;
  endKey?: string;
  skipIfRecentMinutes?: number;
};

type MonitorGlobal = typeof globalThis & {
  __competitorScanPromise?: Promise<CompetitorScanResult>;
};

export type CompetitorScanResult = {
  skipped: boolean;
  scanId?: string;
  status?: string;
  checkedSlots?: number;
  changedSlots?: number;
  bookingEvents?: number;
  cancellationEvents?: number;
  startKey?: string;
  endKey?: string;
  errors?: ScannerResult["errors"];
};

function kstDateKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function addDays(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + amount);
  return kstDateKey(date);
}

function daysBetween(fromKey: string, toKey: string) {
  const from = new Date(`${fromKey}T00:00:00+09:00`);
  const to = new Date(`${toKey}T00:00:00+09:00`);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function endOfMonthKey(dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
}

function resolveRange(options: RunOptions) {
  const today = kstDateKey();
  if (options.mode === "range") {
    if (!options.startKey || !options.endKey) throw new Error("Range scan requires startKey and endKey");
    return { startKey: options.startKey, endKey: options.endKey };
  }
  if (options.mode === "today") return { startKey: today, endKey: today };
  if (options.mode === "today-next") return { startKey: today, endKey: addDays(today, 1) };
  if (options.mode === "next-week") return { startKey: addDays(today, 1), endKey: addDays(today, 7) };
  if (options.mode === "daily") return { startKey: today, endKey: addDays(today, 7) };
  if (options.mode === "monthly") return { startKey: today, endKey: endOfMonthKey(today) };

  const todayDate = new Date(`${today}T00:00:00+09:00`);
  const daysUntilSunday = (7 - todayDate.getDay()) % 7;
  return { startKey: today, endKey: addDays(today, daysUntilSunday) };
}

function cancellationFeeRate(competitorId: string, useDateKey: string, checkedAt: Date) {
  const remainingDays = daysBetween(kstDateKey(checkedAt), useDateKey);
  if (competitorId === "synergy") {
    if (remainingDays >= 7) return 0;
    if (remainingDays === 6) return 30;
    if (remainingDays === 5) return 50;
    if (remainingDays === 4) return 70;
    return 100;
  }

  if (remainingDays >= 2) return 0;
  if (remainingDays === 1) return 50;
  return 100;
}

function parseScannerResult(stdout: string) {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`Competitor scanner returned no result. stdout=${stdout.slice(-800)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as ScannerResult;
}

async function executeScanner(startKey: string, endKey: string) {
  const result = await execFileAsync(
    process.execPath,
    ["rpa/competitor-scan.mjs", `--start=${startKey}`, `--end=${endKey}`],
    {
      cwd: process.cwd(),
      env: process.env,
      timeout: 12 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  return parseScannerResult(result.stdout);
}

type ExistingSlot = Awaited<ReturnType<typeof prisma.competitorSlot.findMany>>[number];
const MEMOROOM_ROOMS = ["머무룸1", "머무룸2"] as const;

function resolveState(current: ExistingSlot | undefined, observation: ScannerObservation) {
  const checkedAt = new Date(observation.checkedAt);
  let state: string = observation.observedState;
  let pendingState: string | null = null;
  let pendingCount = 0;
  let pendingSince: Date | null = null;
  let reason = observation.reason;
  let eventType: "BOOKED" | "CANCELLED" | null = null;

  if (observation.observedState === "POLICY_CLOSED") {
    if (current?.state === "BOOKED") {
      state = "BOOKED";
      reason = "POLICY_CLOSED_PRESERVED_BOOKING";
    } else if (current?.state === "AVAILABLE") {
      state = "AVAILABLE";
      reason = "POLICY_CLOSED_PRESERVED_AVAILABILITY";
    }
  } else if (observation.observedState === "UNKNOWN") {
    if (current && ["AVAILABLE", "BOOKED", "POLICY_CLOSED"].includes(current.state)) {
      state = current.state;
      reason = "TRANSIENT_UNKNOWN_PRESERVED_PREVIOUS_STATE";
    }
  } else if (current?.state === "BOOKED" && observation.observedState === "AVAILABLE") {
    const previousPendingCount = current.pendingState === "AVAILABLE" ? current.pendingCount : 0;
    if (previousPendingCount < 1) {
      state = "BOOKED";
      pendingState = "AVAILABLE";
      pendingCount = 1;
      pendingSince = checkedAt;
      reason = "CANCELLATION_PENDING_CONFIRMATION";
    } else {
      state = "AVAILABLE";
      eventType = "CANCELLED";
      reason = "CANCELLATION_CONFIRMED_BY_TWO_SCANS";
    }
  }

  // Only a known AVAILABLE -> BOOKED transition proves that this booking
  // appeared after monitoring began. Initial baselines and UNKNOWN states do
  // not have enough evidence for an opportunity-loss judgement.
  if (state === "BOOKED" && current?.state === "AVAILABLE") eventType = "BOOKED";

  return {
    state,
    pendingState,
    pendingCount,
    pendingSince,
    reason,
    eventType,
    checkedAt,
  };
}

type OpportunitySlot = {
  id: string;
  competitorId: string;
  dateKey: string;
  hour: number;
  firstObservedAt: Date;
  lastBookedAt: Date | null;
  opportunityLostRooms: string | null;
};

function opportunityDetectionTime(slot: OpportunitySlot) {
  return slot.lastBookedAt || slot.firstObservedAt;
}

/**
 * Repairs only missing competitor judgements. A stored result is never recalculated,
 * because opportunity loss must describe the Memoroom calendar at first discovery.
 */
async function reconcileMissingOpportunityLoss(startKey: string, endKey: string) {
  const bookedSlots = await prisma.competitorSlot.findMany({
    where: {
      dateKey: { gte: startKey, lte: endKey },
      state: "BOOKED",
    },
    orderBy: [{ competitorId: "asc" }, { dateKey: "asc" }, { hour: "asc" }],
    select: {
      id: true,
      competitorId: true,
      dateKey: true,
      hour: true,
      firstObservedAt: true,
      lastBookedAt: true,
      opportunityLostRooms: true,
    },
  });

  const groups: OpportunitySlot[][] = [];
  for (const slot of bookedSlots) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    const sameDiscovery = previous
      && opportunityDetectionTime(previous).getTime() === opportunityDetectionTime(slot).getTime();
    if (!previous
      || previous.competitorId !== slot.competitorId
      || previous.dateKey !== slot.dateKey
      || previous.hour + 1 !== slot.hour
      || !sameDiscovery) {
      groups.push([slot]);
    } else {
      previousGroup!.push(slot);
    }
  }

  let repairedSlots = 0;
  const judgementGroups: OpportunitySlot[][] = [];
  for (const group of groups) {
    const first = group[0];
    const isSingleHourTriground = first.competitorId.startsWith("triground-") && group.length < 2;
    if (isSingleHourTriground) {
      const result = await prisma.competitorSlot.updateMany({
        where: {
          id: { in: group.map((slot) => slot.id) },
          OR: [
            { opportunityLostRooms: null },
            { opportunityLostRooms: { not: "NONE" } },
          ],
        },
        data: { opportunityLostRooms: "NONE" },
      });
      repairedSlots += result.count;
      continue;
    }
    if (group.some((slot) => slot.opportunityLostRooms === null)) judgementGroups.push(group);
  }

  if (judgementGroups.length === 0) return repairedSlots;

  const rangeStart = new Date(`${startKey}T00:00:00+09:00`);
  const rangeEnd = new Date(`${addDays(endKey, 1)}T00:00:00+09:00`);
  const reservations = await prisma.reservation.findMany({
    where: {
      roomName: { in: [...MEMOROOM_ROOMS] },
      startTime: { lt: rangeEnd },
      endTime: { gt: rangeStart },
    },
    select: {
      roomName: true,
      startTime: true,
      endTime: true,
      createdAt: true,
      updatedAt: true,
      status: true,
    },
  });

  for (const group of judgementGroups) {
    const first = group[0];
    const last = group.at(-1)!;
    const detectedAt = opportunityDetectionTime(first);
    const segmentStart = new Date(
      `${first.dateKey}T${String(first.hour).padStart(2, "0")}:00:00+09:00`,
    );
    const segmentEnd = new Date(
      `${last.dateKey}T${String(last.hour + 1).padStart(2, "0")}:00:00+09:00`,
    );

    // A past/current baseline cannot prove that a customer chose the competitor.
    // Record NONE so the row is no longer left in an ambiguous NULL state.
    let opportunityLostRooms = "NONE";
    if (segmentStart > detectedAt) {
      const lostRooms = MEMOROOM_ROOMS.filter((roomName) => {
        const occupiedAtDiscovery = reservations.some((reservation) => {
          if (reservation.roomName !== roomName || reservation.createdAt > detectedAt) return false;
          const wasActiveAtDiscovery = reservation.status === "CONFIRMED"
            || (reservation.status === "CANCELLED" && reservation.updatedAt > detectedAt);
          return wasActiveAtDiscovery
            && reservation.startTime < segmentEnd
            && reservation.endTime > segmentStart;
        });
        return !occupiedAtDiscovery;
      });
      opportunityLostRooms = lostRooms.length > 0 ? lostRooms.join(",") : "NONE";
    }

    const result = await prisma.competitorSlot.updateMany({
      where: {
        id: { in: group.map((slot) => slot.id) },
        opportunityLostRooms: null,
      },
      data: { opportunityLostRooms },
    });
    repairedSlots += result.count;
  }

  if (repairedSlots > 0) {
    console.log(`[Competitor] Repaired ${repairedSlots} missing opportunity-loss slots.`);
  }
  return repairedSlots;
}

async function persistScannerResult(scanId: string, result: ScannerResult) {
  const existingRows = await prisma.competitorSlot.findMany({
    where: {
      dateKey: { gte: result.startKey, lte: result.endKey },
    },
  });
  const currentMap = new Map(
    existingRows.map((slot) => [`${slot.competitorId}|${slot.dateKey}|${slot.hour}`, slot]),
  );
  const rangeStart = new Date(`${result.startKey}T00:00:00+09:00`);
  const rangeEnd = new Date(`${addDays(result.endKey, 1)}T00:00:00+09:00`);
  const memoroomReservations = await prisma.reservation.findMany({
    where: {
      status: "CONFIRMED",
      roomName: { in: [...MEMOROOM_ROOMS] },
      startTime: { lt: rangeEnd },
      endTime: { gt: rangeStart },
    },
    select: { roomName: true, startTime: true, endTime: true },
  });

  let changedSlots = 0;
  let bookingEvents = 0;
  let cancellationEvents = 0;

  for (const observation of result.observations) {
    const key = `${observation.competitorId}|${observation.dateKey}|${observation.hour}`;
    const current = currentMap.get(key);
    const resolved = resolveState(current, observation);
    const changed = Boolean(current && current.state !== resolved.state);
    if (changed) changedSlots += 1;
    let opportunityLostRooms = current?.opportunityLostRooms || null;
    if (resolved.eventType === "CANCELLED") opportunityLostRooms = null;
    const slotStart = new Date(`${observation.dateKey}T${String(observation.hour).padStart(2, "0")}:00:00+09:00`);
    const shouldEvaluateOpportunity = resolved.state === "BOOKED"
      && opportunityLostRooms === null
      && slotStart > resolved.checkedAt;
    if (shouldEvaluateOpportunity) {
      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
      const occupiedRooms = new Set(
        memoroomReservations
          .filter((reservation) => reservation.startTime < slotEnd && reservation.endTime > slotStart)
          .map((reservation) => reservation.roomName),
      );
      const availableRooms = MEMOROOM_ROOMS.filter((roomName) => !occupiedRooms.has(roomName));
      opportunityLostRooms = availableRooms.length > 0 ? availableRooms.join(",") : "NONE";
    }

    const slot = await prisma.competitorSlot.upsert({
      where: {
        competitorId_dateKey_hour: {
          competitorId: observation.competitorId,
          dateKey: observation.dateKey,
          hour: observation.hour,
        },
      },
      create: {
        competitorId: observation.competitorId,
        dateKey: observation.dateKey,
        hour: observation.hour,
        state: resolved.state,
        observedState: observation.observedState,
        firstObservedAt: resolved.checkedAt,
        lastCheckedAt: resolved.checkedAt,
        lastChangedAt: resolved.checkedAt,
        lastBookedAt: resolved.eventType === "BOOKED" ? resolved.checkedAt : null,
        lastReleasedAt: resolved.eventType === "CANCELLED" ? resolved.checkedAt : null,
        lastScanId: scanId,
        pendingState: resolved.pendingState,
        pendingCount: resolved.pendingCount,
        pendingSince: resolved.pendingSince,
        opportunityLostRooms,
      },
      update: {
        state: resolved.state,
        observedState: observation.observedState,
        lastCheckedAt: resolved.checkedAt,
        lastChangedAt: changed ? resolved.checkedAt : current?.lastChangedAt,
        lastBookedAt: resolved.eventType === "BOOKED" ? resolved.checkedAt : current?.lastBookedAt,
        lastReleasedAt: resolved.eventType === "CANCELLED" ? resolved.checkedAt : current?.lastReleasedAt,
        lastScanId: scanId,
        pendingState: resolved.pendingState,
        pendingCount: resolved.pendingCount,
        pendingSince: resolved.pendingSince,
        opportunityLostRooms,
      },
    });

    await prisma.competitorSlotObservation.create({
      data: {
        scanId,
        competitorId: observation.competitorId,
        dateKey: observation.dateKey,
        hour: observation.hour,
        observedState: observation.observedState,
        effectiveState: resolved.state,
        reason: resolved.reason,
        checkedAt: resolved.checkedAt,
      },
    });

    if (resolved.eventType) {
      const feeRate = resolved.eventType === "CANCELLED"
        ? cancellationFeeRate(observation.competitorId, observation.dateKey, resolved.checkedAt)
        : null;
      await prisma.competitorSlotEvent.create({
        data: {
          scanId,
          competitorId: observation.competitorId,
          dateKey: observation.dateKey,
          hour: observation.hour,
          eventType: resolved.eventType,
          previousState: current?.state || null,
          newState: resolved.state,
          cancellationFeeRate: feeRate,
          opportunityLostRooms: resolved.eventType === "BOOKED" ? opportunityLostRooms : null,
          occurredAt: resolved.checkedAt,
        },
      });
      if (resolved.eventType === "BOOKED") bookingEvents += 1;
      if (resolved.eventType === "CANCELLED") cancellationEvents += 1;
    }

    currentMap.set(key, slot);
  }

  await reconcileMissingOpportunityLoss(result.startKey, result.endKey);

  return { changedSlots, bookingEvents, cancellationEvents };
}

async function runScan(options: RunOptions): Promise<CompetitorScanResult> {
  const range = resolveRange(options);
  if (options.skipIfRecentMinutes && options.skipIfRecentMinutes > 0) {
    const recent = await prisma.competitorScan.findFirst({
      where: {
        status: "COMPLETED",
        startedAt: { gte: new Date(Date.now() - options.skipIfRecentMinutes * 60_000) },
      },
      orderBy: { startedAt: "desc" },
    });
    if (recent) return { skipped: true, scanId: recent.id, status: recent.status };
  }

  const scan = await prisma.competitorScan.create({
    data: {
      mode: options.mode,
      targetStartKey: range.startKey,
      targetEndKey: range.endKey,
    },
  });

  try {
    const scannerResult = await executeScanner(range.startKey, range.endKey);
    const changes = await persistScannerResult(scan.id, scannerResult);
    const status = scannerResult.observations.length === 0
      ? "FAILED"
      : scannerResult.errors.length > 0
        ? "PARTIAL"
        : "COMPLETED";
    const error = scannerResult.errors.length > 0
      ? scannerResult.errors.map((item) => `${item.competitorId}: ${item.message}`).join(" / ").slice(0, 2000)
      : null;

    await prisma.competitorScan.update({
      where: { id: scan.id },
      data: {
        status,
        checkedSlots: scannerResult.observations.length,
        changedSlots: changes.changedSlots,
        error,
        finishedAt: new Date(),
      },
    });

    if (status === "COMPLETED") {
      await resolveAdminAlertsByType(ALERT_TYPE);
    } else {
      await createAdminAlert({
        type: ALERT_TYPE,
        severity: status === "FAILED" ? "CRITICAL" : "WARNING",
        title: status === "FAILED" ? "경쟁사 일정 점검 실패" : "경쟁사 일정 일부 확인 필요",
        message: error || "경쟁사 공개 예약 화면에서 시간 정보를 읽지 못했습니다.",
        dedupeKey: "competitor-monitor-scan-error",
      });
    }

    return {
      skipped: false,
      scanId: scan.id,
      status,
      checkedSlots: scannerResult.observations.length,
      changedSlots: changes.changedSlots,
      bookingEvents: changes.bookingEvents,
      cancellationEvents: changes.cancellationEvents,
      startKey: range.startKey,
      endKey: range.endKey,
      errors: scannerResult.errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.competitorScan.update({
      where: { id: scan.id },
      data: { status: "FAILED", error: message.slice(0, 2000), finishedAt: new Date() },
    });
    await createAdminAlert({
      type: ALERT_TYPE,
      severity: "CRITICAL",
      title: "경쟁사 일정 점검 실패",
      message,
      dedupeKey: "competitor-monitor-scan-error",
    });
    throw error;
  }
}

export function runCompetitorScan(options: RunOptions): Promise<CompetitorScanResult> {
  const globalState = globalThis as MonitorGlobal;
  if (globalState.__competitorScanPromise) return globalState.__competitorScanPromise;

  globalState.__competitorScanPromise = runScan(options).finally(() => {
    delete globalState.__competitorScanPromise;
  });
  return globalState.__competitorScanPromise;
}
