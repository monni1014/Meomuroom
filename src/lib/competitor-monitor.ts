import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createAdminAlert, resolveAdminAlertsByType } from "@/lib/admin-alerts";
import {
  resolveCancellationConfirmationRange,
  resolveCompetitorScanRange,
  type CompetitorScanMode,
} from "@/lib/competitor-scan-range";
import { shouldCreateBookingDiscoveryEvent } from "@/lib/competitor-booking-discovery";
import {
  buildSynergyBookingPushes,
  buildSynergySpacecloudPushes,
} from "@/lib/competitor-booking-push-policy";
import { competitorCancellationFeeRate } from "@/lib/competitor-cancellation";
import { prisma } from "@/lib/prisma";
import { sendPushNotification } from "@/lib/push-notifications";
import { getRpaProxyCircuitState, isRpaPausedForProxy } from "@/lib/rpa-proxy-circuit";
import {
  crossCheckSynergySpacecloudWithNaver,
  SPACECLOUD_ONLY_CLOSED_REASON,
} from "@/lib/synergy-spacecloud-cross-check";

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const ALERT_TYPE = "COMPETITOR_MONITOR";
const SYNERGY_SPACECLOUD_ALERT_TYPE = "COMPETITOR_SYNERGY_SPACECLOUD_MONITOR";
const VISIBLE_COMPETITOR_IDS = ["synergy", "triground-a", "triground-b"];
const STALE_SCAN_MINUTES = 15;
const SCAN_LOCK_PATH = resolve("rpa/.locks/competitor-monitor.lock");

export type { CompetitorScanMode } from "@/lib/competitor-scan-range";

type ScannerObservation = {
  competitorId: string;
  dateKey: string;
  hour: number;
  observedState: "AVAILABLE" | "BOOKED" | "POLICY_CLOSED" | "UNKNOWN" | "NOT_OFFERED" | "NOT_YET_OPEN";
  reason: string | null;
  checkedAt: string;
};

type ScannerResult = {
  startKey: string;
  endKey: string;
  observations: ScannerObservation[];
  evidence: ScannerEvidence[];
  errors: Array<{ competitorId: string; dateKey?: string | null; message: string }>;
};

type ScannerEvidence = {
  competitorId: string;
  dateKey: string | null;
  startHour: number | null;
  endHour: number | null;
  reasonCode: string;
  reason: string;
  imagePath: string;
  capturedAt: string;
};

type RunOptions = {
  mode: CompetitorScanMode;
  startKey?: string;
  endKey?: string;
  skipIfRecentMinutes?: number;
};

type SynergySpacecloudRunOptions = {
  startKey?: string;
  endKey?: string;
  mode?: "synergy-spacecloud-daily" | "synergy-spacecloud-followup";
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
  reason?: string;
};

function kstDateKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function addDays(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + amount);
  return kstDateKey(date);
}

function processIsRunning(pid: number | null) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

async function acquireMonitorLock() {
  await mkdir(dirname(SCAN_LOCK_PATH), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(SCAN_LOCK_PATH, "wx");
      await handle.writeFile(
        `Competitor monitor\npid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`,
        "utf8",
      );
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(SCAN_LOCK_PATH, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const [content, info] = await Promise.all([
        readFile(SCAN_LOCK_PATH, "utf8").catch(() => ""),
        stat(SCAN_LOCK_PATH).catch(() => null),
      ]);
      if (!info) continue;
      const pid = Number(/(?:^|\n)pid=(\d+)(?:\n|$)/.exec(content)?.[1] || 0) || null;
      const running = processIsRunning(pid);
      const staleWithoutOwner = running === null
        && Date.now() - info.mtimeMs >= STALE_SCAN_MINUTES * 60_000;
      if (running === false || staleWithoutOwner) {
        await rm(SCAN_LOCK_PATH, { force: true });
        continue;
      }
      return null;
    }
  }

  return null;
}

function parseScannerResult(stdout: string) {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`Competitor scanner returned no result. stdout=${stdout.slice(-800)}`);
  const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as Partial<ScannerResult>;
  if (!parsed.startKey || !parsed.endKey || !Array.isArray(parsed.observations)) {
    throw new Error("Competitor scanner returned an invalid result");
  }
  return {
    startKey: parsed.startKey,
    endKey: parsed.endKey,
    observations: parsed.observations,
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
  };
}

async function executeScanner(startKey: string, endKey: string) {
  const previousStates = await prisma.competitorSlot.findMany({
    where: {
      competitorId: { in: VISIBLE_COMPETITOR_IDS },
      dateKey: { gte: startKey, lte: endKey },
    },
    select: {
      competitorId: true,
      dateKey: true,
      hour: true,
      state: true,
      pendingState: true,
    },
  });
  const stateFile = resolve(
    process.cwd(),
    "rpa/.runtime",
    `competitor-previous-states-${randomUUID()}.json`,
  );
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(previousStates), "utf8");

  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "rpa/competitor-scan.mjs",
        `--start=${startKey}`,
        `--end=${endKey}`,
        `--previous-states=${stateFile}`,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 12 * 60 * 1000,
        maxBuffer: 1024 * 1024 * 8,
      },
    );
    return parseScannerResult(result.stdout);
  } finally {
    await unlink(stateFile).catch(() => undefined);
  }
}

async function executeSynergySpacecloudScanner(startKey: string, endKey: string) {
  const result = await execFileAsync(
    process.execPath,
    [
      "rpa/synergy-spacecloud-scan.mjs",
      `--start=${startKey}`,
      `--end=${endKey}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      timeout: 2 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 4,
    },
  );
  return parseScannerResult(result.stdout);
}

async function verifySynergySpacecloudAgainstNaver(result: ScannerResult) {
  const naverSlots = await prisma.competitorSlot.findMany({
    where: {
      competitorId: "synergy",
      dateKey: { gte: result.startKey, lte: result.endKey },
    },
    select: {
      dateKey: true,
      hour: true,
      state: true,
    },
  });

  return {
    ...result,
    observations: crossCheckSynergySpacecloudWithNaver(
      result.observations,
      naverSlots,
    ),
  };
}

const EVIDENCE_REASON_LABELS: Record<string, string> = {
  SLOT_READ_UNCERTAIN: "시간 슬롯 일부를 읽지 못했습니다.",
  CANCELLATION_PENDING_CONFIRMATION: "기존 예약 시간이 열려 보여 취소 여부를 다시 확인해야 합니다.",
  CUTOFF_BLOCKED_CONFIRMATION: "당일 예약 마감 때문에 취소 여부를 화면에서 확정할 수 없습니다.",
  DATE_SCAN_ERROR: "해당 날짜 또는 시간 화면을 정상적으로 읽지 못했습니다.",
  COMPETITOR_PAGE_ERROR: "경쟁사 예약 페이지를 정상적으로 열지 못했습니다.",
};

function normalizeEvidenceImagePath(imagePath: string) {
  const root = resolve(process.cwd(), "rpa/screenshots");
  const absolutePath = isAbsolute(imagePath)
    ? resolve(imagePath)
    : resolve(process.cwd(), imagePath);
  const fromRoot = relative(root, absolutePath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`Competitor evidence path is outside the screenshot directory: ${imagePath}`);
  }
  return relative(process.cwd(), absolutePath).replaceAll("\\", "/");
}

async function discardEvidenceImage(imagePath: string) {
  try {
    const normalized = normalizeEvidenceImagePath(imagePath);
    await unlink(resolve(process.cwd(), normalized));
  } catch {
    // The database keeps the first capture for a repeated issue. Cleanup is best-effort.
  }
}

async function rangeEvidenceResolved(evidence: Pick<
  ScannerEvidence,
  "reasonCode" | "competitorId" | "dateKey" | "startHour" | "endHour"
>) {
  if (
    !["CANCELLATION_PENDING_CONFIRMATION", "CUTOFF_BLOCKED_CONFIRMATION"].includes(evidence.reasonCode)
    || !evidence.dateKey
    || evidence.startHour === null
    || evidence.endHour === null
  ) return false;

  const slots = await prisma.competitorSlot.findMany({
    where: {
      competitorId: evidence.competitorId,
      dateKey: evidence.dateKey,
      hour: { gte: evidence.startHour, lt: evidence.endHour },
    },
    select: { state: true, pendingState: true },
  });
  return slots.length === evidence.endHour - evidence.startHour
    && slots.every((slot) => slot.pendingState === null && ["AVAILABLE", "BOOKED"].includes(slot.state));
}

async function persistScannerEvidence(scanId: string, result: ScannerResult) {
  for (const evidence of result.evidence || []) {
    try {
      const imagePath = normalizeEvidenceImagePath(evidence.imagePath);
      const capturedAt = new Date(evidence.capturedAt);
      const resolved = await rangeEvidenceResolved(evidence);
      const existing = await prisma.competitorEvidence.findFirst({
        where: {
          status: "OPEN",
          competitorId: evidence.competitorId,
          dateKey: evidence.dateKey,
          startHour: evidence.startHour,
          endHour: evidence.endHour,
          reasonCode: evidence.reasonCode,
        },
        orderBy: { capturedAt: "desc" },
      });

      if (existing) {
        await prisma.competitorEvidence.update({
          where: { id: existing.id },
          data: {
            scanId,
            status: resolved ? "RESOLVED" : "OPEN",
            lastSeenAt: capturedAt,
            resolvedAt: resolved ? capturedAt : null,
          },
        });
        await discardEvidenceImage(imagePath);
        continue;
      }

      await prisma.competitorEvidence.create({
        data: {
          scanId,
          competitorId: evidence.competitorId,
          dateKey: evidence.dateKey,
          startHour: evidence.startHour,
          endHour: evidence.endHour,
          reasonCode: evidence.reasonCode,
          reason: EVIDENCE_REASON_LABELS[evidence.reasonCode] || evidence.reason,
          imagePath,
          status: resolved ? "RESOLVED" : "OPEN",
          capturedAt,
          lastSeenAt: capturedAt,
          resolvedAt: resolved ? capturedAt : null,
        },
      });
    } catch (error) {
      console.error("[Competitor] Failed to persist evidence:", error);
      await discardEvidenceImage(evidence.imagePath);
    }
  }
}

async function resolveRecoveredEvidence(result: ScannerResult) {
  const successfulDays = new Set(
    result.observations.map((observation) => `${observation.competitorId}|${observation.dateKey}`),
  );
  const uncertainDays = new Set(
    result.observations
      .filter((observation) => observation.observedState === "UNKNOWN")
      .map((observation) => `${observation.competitorId}|${observation.dateKey}`),
  );
  const failedDays = new Set(
    result.errors
      .filter((error) => error.dateKey)
      .map((error) => `${error.competitorId}|${error.dateKey}`),
  );
  const now = new Date();

  for (const key of successfulDays) {
    if (uncertainDays.has(key)) continue;
    const [competitorId, dateKey] = key.split("|");
    await prisma.competitorEvidence.updateMany({
      where: {
        status: "OPEN",
        competitorId,
        dateKey,
        reasonCode: "SLOT_READ_UNCERTAIN",
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (!failedDays.has(key)) {
      await prisma.competitorEvidence.updateMany({
        where: {
          status: "OPEN",
          competitorId,
          dateKey,
          reasonCode: "DATE_SCAN_ERROR",
        },
        data: { status: "RESOLVED", resolvedAt: now },
      });
    }
  }

  for (const competitorId of new Set(result.observations.map((observation) => observation.competitorId))) {
    const competitorFailed = result.errors.some((error) => error.competitorId === competitorId);
    if (!competitorFailed) {
      await prisma.competitorEvidence.updateMany({
        where: { status: "OPEN", competitorId, reasonCode: "COMPETITOR_PAGE_ERROR" },
        data: { status: "RESOLVED", resolvedAt: now },
      });
    }
  }

  const pendingRangeEvidence = await prisma.competitorEvidence.findMany({
    where: {
      status: "OPEN",
      reasonCode: { in: ["CANCELLATION_PENDING_CONFIRMATION", "CUTOFF_BLOCKED_CONFIRMATION"] },
      dateKey: { not: null },
    },
  });
  for (const evidence of pendingRangeEvidence) {
    const key = `${evidence.competitorId}|${evidence.dateKey}`;
    if (!successfulDays.has(key) || uncertainDays.has(key) || failedDays.has(key)) continue;
    if (!await rangeEvidenceResolved(evidence)) continue;
    await prisma.competitorEvidence.update({
      where: { id: evidence.id },
      data: { status: "RESOLVED", resolvedAt: now },
    });
  }
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
  let eventObservedAt = checkedAt;

  const isSpacecloudOnlyClosed = observation.observedState === "POLICY_CLOSED"
    && observation.reason === SPACECLOUD_ONLY_CLOSED_REASON;

  if (isSpacecloudOnlyClosed && current?.state === "BOOKED") {
    const previousPendingCount = current.pendingState === "POLICY_CLOSED"
      ? current.pendingCount
      : 0;
    if (previousPendingCount < 1) {
      state = "BOOKED";
      pendingState = "POLICY_CLOSED";
      pendingCount = 1;
      pendingSince = checkedAt;
      reason = "SPACECLOUD_BOOKING_REMOVAL_PENDING_NAVER_CONFIRMATION";
    } else {
      state = "POLICY_CLOSED";
      eventType = "CANCELLED";
      eventObservedAt = current.pendingSince || checkedAt;
      reason = "SPACECLOUD_BOOKING_REMOVAL_CONFIRMED_BY_NAVER_COMPARISON";
    }
  } else if (observation.observedState === "POLICY_CLOSED") {
    if (current?.state === "BOOKED") {
      state = "BOOKED";
      reason = "POLICY_CLOSED_PRESERVED_BOOKING";
      pendingState = current.pendingState;
      pendingCount = current.pendingCount;
      pendingSince = current.pendingSince;
    } else if (current?.state === "AVAILABLE") {
      state = "AVAILABLE";
      reason = "POLICY_CLOSED_PRESERVED_AVAILABILITY";
      pendingState = current.pendingState;
      pendingCount = current.pendingCount;
      pendingSince = current.pendingSince;
    }
  } else if (["UNKNOWN", "NOT_YET_OPEN"].includes(observation.observedState)) {
    if (current && ["AVAILABLE", "BOOKED", "POLICY_CLOSED"].includes(current.state)) {
      state = current.state;
      reason = observation.observedState === "NOT_YET_OPEN"
        ? "BOOKING_WINDOW_NOT_OPEN_PRESERVED_PREVIOUS_STATE"
        : "TRANSIENT_UNKNOWN_PRESERVED_PREVIOUS_STATE";
      pendingState = current.pendingState;
      pendingCount = current.pendingCount;
      pendingSince = current.pendingSince;
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
      eventObservedAt = current.pendingSince || checkedAt;
      reason = "CANCELLATION_CONFIRMED_BY_TWO_SCANS";
    }
  }

  // The operator needs every first discovery to be visible, including a
  // booking already present when a newly extended scan horizon is first read.
  // lastBookedAt makes this one-shot for legacy baseline rows as well.
  if (shouldCreateBookingDiscoveryEvent(state, current)) eventType = "BOOKED";

  return {
    state,
    pendingState,
    pendingCount,
    pendingSince,
    reason,
    eventType,
    checkedAt,
    eventObservedAt,
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
async function reconcileMissingOpportunityLoss(
  startKey: string,
  endKey: string,
  competitorIds = VISIBLE_COMPETITOR_IDS,
) {
  const bookedSlots = await prisma.competitorSlot.findMany({
    where: {
      competitorId: { in: competitorIds },
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
    // A slot that was already closed in the first baseline has no preceding
    // AVAILABLE observation. Keep the observed booking on the grid, but do not
    // infer that the customer chose the competitor over Memoroom.
    if (group.every((slot) => slot.lastBookedAt === null)) {
      const result = await prisma.competitorSlot.updateMany({
        where: {
          id: { in: group.map((slot) => slot.id) },
          opportunityLostRooms: null,
        },
        data: { opportunityLostRooms: "NONE" },
      });
      repairedSlots += result.count;
      continue;
    }

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

async function withDatabaseWriteRetry<T>(label: string, operation: () => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /SQLITE_BUSY|database is locked|timed?\s*out|transaction.*closed/i.test(message);
      if (!retryable || attempt === 3) throw error;
      console.warn(`[Competitor] ${label} was busy; retry ${attempt}/3.`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 300));
    }
  }
  throw new Error(`${label} failed without an error`);
}

async function persistScannerResult(
  scanId: string,
  result: ScannerResult,
  opportunityCompetitorIds = VISIBLE_COMPETITOR_IDS,
) {
  const existingRows = await prisma.competitorSlot.findMany({
    where: {
      competitorId: { in: [...new Set(result.observations.map((item) => item.competitorId))] },
      dateKey: { gte: result.startKey, lte: result.endKey },
    },
  });
  const currentMap = new Map(
    existingRows.map((slot) => [`${slot.competitorId}|${slot.dateKey}|${slot.hour}`, slot]),
  );
  const observationGroups = new Map<string, ScannerObservation[]>();
  for (const observation of result.observations) {
    const groupKey = `${observation.competitorId}|${observation.dateKey}`;
    const group = observationGroups.get(groupKey) || [];
    group.push(observation);
    observationGroups.set(groupKey, group);
  }

  let changedSlots = 0;
  let bookingEvents = 0;
  let cancellationEvents = 0;

  const originalBookingDurationHours = (current: ExistingSlot | undefined) => {
    if (!current) return 1;
    const bookingIdentity = current.lastBookedAt?.getTime() ?? null;
    let duration = 1;

    for (const direction of [-1, 1]) {
      let hour = current.hour + direction;
      while (true) {
        const adjacent = currentMap.get(`${current.competitorId}|${current.dateKey}|${hour}`);
        if (!adjacent) break;
        const adjacentIdentity = adjacent.lastBookedAt?.getTime() ?? null;
        if (adjacentIdentity !== bookingIdentity) break;
        // Baseline slots have no booking identity. Only contiguous slots that
        // are still booked can safely be treated as the same original block.
        if (bookingIdentity === null && adjacent.state !== "BOOKED") break;
        duration += 1;
        hour += direction;
      }
    }
    return duration;
  };

  for (const [groupKey, observations] of observationGroups) {
    const plans = observations.map((observation) => {
      const key = `${observation.competitorId}|${observation.dateKey}|${observation.hour}`;
      const current = currentMap.get(key);
      const resolved = resolveState(current, observation);
      const changed = Boolean(current && current.state !== resolved.state);
      let opportunityLostRooms = current?.opportunityLostRooms || null;
      if (resolved.eventType === "CANCELLED" || resolved.eventType === "BOOKED") {
        opportunityLostRooms = null;
      } else if (resolved.state === "BOOKED" && !current?.lastBookedAt) {
        // Retain compatibility for legacy baseline rows that have not yet been
        // revisited by the first-discovery event policy.
        opportunityLostRooms = "NONE";
      }
      const bookingDurationHours = resolved.eventType === "CANCELLED"
        ? originalBookingDurationHours(current)
        : 0;
      const feeRate = resolved.eventType === "CANCELLED"
        ? competitorCancellationFeeRate(
            observation.competitorId,
            observation.dateKey,
            resolved.eventObservedAt,
            bookingDurationHours,
          )
        : null;
      return {
        key,
        observation,
        current,
        resolved,
        changed,
        opportunityLostRooms,
        feeRate,
      };
    });

    const committedSlots = await withDatabaseWriteRetry(`persist ${groupKey}`, () => (
      prisma.$transaction(async (tx) => {
        const slots = [];
        for (const plan of plans) {
          const { observation, current, resolved, changed, opportunityLostRooms } = plan;
          const slot = await tx.competitorSlot.upsert({
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
          slots.push(slot);
        }

        await tx.competitorSlotObservation.createMany({
          data: plans.map(({ observation, resolved }) => ({
            scanId,
            competitorId: observation.competitorId,
            dateKey: observation.dateKey,
            hour: observation.hour,
            observedState: observation.observedState,
            effectiveState: resolved.state,
            reason: resolved.reason,
            checkedAt: resolved.checkedAt,
          })),
        });

        const eventPlans = plans.filter(({ resolved }) => resolved.eventType !== null);
        if (eventPlans.length > 0) {
          await tx.competitorSlotEvent.createMany({
            data: eventPlans.map(({ observation, current, resolved, feeRate }) => ({
              scanId,
              competitorId: observation.competitorId,
              dateKey: observation.dateKey,
              hour: observation.hour,
              eventType: resolved.eventType!,
              previousState: current?.state || null,
              newState: resolved.state,
              cancellationFeeRate: feeRate,
              opportunityLostRooms: null,
              occurredAt: resolved.eventObservedAt,
            })),
          });
        }

        return slots;
      }, { maxWait: 10_000, timeout: 30_000 })
    ));

    plans.forEach((plan, index) => {
      currentMap.set(plan.key, committedSlots[index]);
      if (plan.changed) changedSlots += 1;
      if (plan.resolved.eventType === "BOOKED") bookingEvents += 1;
      if (plan.resolved.eventType === "CANCELLED") cancellationEvents += 1;
    });
  }

  if (opportunityCompetitorIds.length > 0) {
    await reconcileMissingOpportunityLoss(
      result.startKey,
      result.endKey,
      opportunityCompetitorIds,
    );
  }

  return { changedSlots, bookingEvents, cancellationEvents };
}

async function sendSynergyBookingDiscoveryPushes(scanId: string) {
  const events = await prisma.competitorSlotEvent.findMany({
    where: {
      scanId,
      competitorId: "synergy",
      eventType: { in: ["BOOKED", "CANCELLED"] },
    },
    select: {
      scanId: true,
      competitorId: true,
      dateKey: true,
      hour: true,
      eventType: true,
    },
  });
  const pushes = buildSynergyBookingPushes(events);

  for (const push of pushes) {
    const result = await sendPushNotification(push, { excludeAppleWebPush: true });
    console.log(
      `[Competitor] Synergy booking push sent: tag=${push.tag}, sent=${result.sent}, failed=${result.failed}, apple-excluded=true`,
    );
  }
}

async function sendSynergySpacecloudPushes(scanId: string) {
  const events = await prisma.competitorSlotEvent.findMany({
    where: {
      scanId,
      competitorId: "synergy-spacecloud",
      eventType: { in: ["BOOKED", "CANCELLED"] },
    },
    select: {
      scanId: true,
      competitorId: true,
      dateKey: true,
      hour: true,
      eventType: true,
      cancellationFeeRate: true,
    },
  });
  const pushes = buildSynergySpacecloudPushes(events);

  for (const push of pushes) {
    const result = await sendPushNotification(push, { excludeAppleWebPush: true });
    console.log(
      `[Competitor] Synergy SpaceCloud push sent: tag=${push.tag}, sent=${result.sent}, failed=${result.failed}, apple-excluded=true`,
    );
  }
}

async function runScan(options: RunOptions): Promise<CompetitorScanResult> {
  const range = resolveCompetitorScanRange(options);

  // This function runs only after this process acquired the exclusive scan lock.
  // Therefore every pre-existing RUNNING row belongs to an interrupted process
  // and can be closed immediately instead of lingering for 15 minutes.
  await prisma.competitorScan.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "FAILED",
      error: "Competitor scan was interrupted before completion.",
      finishedAt: new Date(),
    },
  });

  if (options.skipIfRecentMinutes && options.skipIfRecentMinutes > 0) {
    const recent = await prisma.competitorScan.findFirst({
      where: {
        mode: { notIn: ["synergy-spacecloud-daily", "synergy-spacecloud-followup"] },
        status: "COMPLETED",
        startedAt: { gte: new Date(Date.now() - options.skipIfRecentMinutes * 60_000) },
        targetStartKey: { lte: range.startKey },
        targetEndKey: { gte: range.endKey },
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
    await persistScannerEvidence(scan.id, scannerResult);
    await resolveRecoveredEvidence(scannerResult);

    const pendingCancellationDates = await prisma.competitorSlot.findMany({
      where: {
        competitorId: { in: VISIBLE_COMPETITOR_IDS },
        dateKey: { gte: range.startKey, lte: range.endKey },
        state: "BOOKED",
        pendingState: "AVAILABLE",
        pendingCount: { gte: 1 },
      },
      distinct: ["dateKey"],
      orderBy: { dateKey: "asc" },
      select: { dateKey: true },
    });
    const confirmationRange = resolveCancellationConfirmationRange(
      pendingCancellationDates.map((item) => item.dateKey),
    );
    let confirmationResult: ScannerResult | null = null;
    let confirmationChanges = { changedSlots: 0, bookingEvents: 0, cancellationEvents: 0 };
    if (confirmationRange) {
      console.log(
        `[Competitor] Confirming possible cancellations ${confirmationRange.startKey}..${confirmationRange.endKey}.`,
      );
      confirmationResult = await executeScanner(confirmationRange.startKey, confirmationRange.endKey);
      confirmationChanges = await persistScannerResult(scan.id, confirmationResult);
      await persistScannerEvidence(scan.id, confirmationResult);
      await resolveRecoveredEvidence(confirmationResult);
    }

    const allObservations = [
      ...scannerResult.observations,
      ...(confirmationResult?.observations || []),
    ];
    const allErrors = [
      ...scannerResult.errors,
      ...(confirmationResult?.errors || []),
    ];
    const uncertainSlots = allObservations.filter(
      (observation) => observation.observedState === "UNKNOWN",
    ).length;
    const status = allObservations.length === 0
      ? "FAILED"
      : allErrors.length > 0 || uncertainSlots > 0
        ? "PARTIAL"
        : "COMPLETED";
    const issueMessages = allErrors.map((item) => `${item.competitorId}: ${item.message}`);
    if (uncertainSlots > 0) issueMessages.push(`${uncertainSlots} slot(s) need screenshot review`);
    const error = issueMessages.length > 0 ? issueMessages.join(" / ").slice(0, 2000) : null;

    await prisma.competitorScan.update({
      where: { id: scan.id },
      data: {
        status,
        checkedSlots: allObservations.length,
        changedSlots: changes.changedSlots + confirmationChanges.changedSlots,
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

    try {
      await sendSynergyBookingDiscoveryPushes(scan.id);
    } catch (pushError) {
      console.error("[Competitor] Could not send Synergy booking discovery push:", pushError);
    }

    return {
      skipped: false,
      scanId: scan.id,
      status,
      checkedSlots: allObservations.length,
      changedSlots: changes.changedSlots + confirmationChanges.changedSlots,
      bookingEvents: changes.bookingEvents + confirmationChanges.bookingEvents,
      cancellationEvents: changes.cancellationEvents + confirmationChanges.cancellationEvents,
      startKey: range.startKey,
      endKey: range.endKey,
      errors: allErrors,
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

function endOfNextMonthKey(todayKey: string) {
  const [year, month] = todayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month + 1, 0));
  return date.toISOString().slice(0, 10);
}

async function runSynergySpacecloudRangeScan(
  options: SynergySpacecloudRunOptions = {},
): Promise<CompetitorScanResult> {
  const startKey = options.startKey || kstDateKey();
  const endKey = options.endKey || endOfNextMonthKey(startKey);
  const mode = options.mode || "synergy-spacecloud-daily";

  const existingHiddenSlots = await prisma.competitorSlot.count({
    where: {
      competitorId: "synergy-spacecloud",
      dateKey: { gte: startKey, lte: endKey },
    },
  });
  const baseline = existingHiddenSlots === 0;
  const scan = await prisma.competitorScan.create({
    data: {
      mode,
      targetStartKey: startKey,
      targetEndKey: endKey,
    },
  });

  try {
    const scannerResult = await verifySynergySpacecloudAgainstNaver(
      await executeSynergySpacecloudScanner(startKey, endKey),
    );
    const changes = await persistScannerResult(scan.id, scannerResult, []);

    const pendingCancellationDates = await prisma.competitorSlot.findMany({
      where: {
        competitorId: "synergy-spacecloud",
        dateKey: { gte: startKey, lte: endKey },
        state: "BOOKED",
        pendingState: { in: ["AVAILABLE", "POLICY_CLOSED"] },
        pendingCount: { gte: 1 },
      },
      distinct: ["dateKey"],
      orderBy: { dateKey: "asc" },
      select: { dateKey: true },
    });
    const confirmationRange = resolveCancellationConfirmationRange(
      pendingCancellationDates.map((item) => item.dateKey),
    );
    let confirmationResult: ScannerResult | null = null;
    let confirmationChanges = { changedSlots: 0, bookingEvents: 0, cancellationEvents: 0 };
    if (confirmationRange) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
      confirmationResult = await verifySynergySpacecloudAgainstNaver(
        await executeSynergySpacecloudScanner(
          confirmationRange.startKey,
          confirmationRange.endKey,
        ),
      );
      confirmationChanges = await persistScannerResult(scan.id, confirmationResult, []);
    }

    const allObservations = [
      ...scannerResult.observations,
      ...(confirmationResult?.observations || []),
    ];
    const allErrors = [
      ...scannerResult.errors,
      ...(confirmationResult?.errors || []),
    ];
    const uncertainSlots = allObservations.filter(
      (observation) => observation.observedState === "UNKNOWN",
    ).length;
    const status = allObservations.length === 0
      ? "FAILED"
      : allErrors.length > 0 || uncertainSlots > 0
        ? "PARTIAL"
        : "COMPLETED";
    const issueMessages = allErrors.map((item) => `${item.competitorId}: ${item.message}`);
    if (uncertainSlots > 0) issueMessages.push(`${uncertainSlots} slot(s) could not be read`);
    const errorMessage = issueMessages.length > 0 ? issueMessages.join(" / ").slice(0, 2000) : null;

    await prisma.competitorScan.update({
      where: { id: scan.id },
      data: {
        status,
        checkedSlots: allObservations.length,
        changedSlots: changes.changedSlots + confirmationChanges.changedSlots,
        error: errorMessage,
        finishedAt: new Date(),
      },
    });

    if (status === "COMPLETED") {
      await resolveAdminAlertsByType(SYNERGY_SPACECLOUD_ALERT_TYPE);
    } else {
      await createAdminAlert({
        type: SYNERGY_SPACECLOUD_ALERT_TYPE,
        severity: status === "FAILED" ? "CRITICAL" : "WARNING",
        title: status === "FAILED" ? "시너지 스클 일정 점검 실패" : "시너지 스클 일정 일부 확인 필요",
        message: errorMessage || "시너지 스클 공개 예약표에서 일부 시간 정보를 읽지 못했습니다.",
        dedupeKey: "competitor-synergy-spacecloud-scan-error",
      });
    }

    if (baseline) {
      await prisma.competitorSlotEvent.updateMany({
        where: { scanId: scan.id, competitorId: "synergy-spacecloud" },
        data: { acknowledgedAt: new Date() },
      });
      console.log("[Competitor] Synergy SpaceCloud baseline stored without discovery pushes.");
    } else {
      await sendSynergySpacecloudPushes(scan.id);
    }

    return {
      skipped: false,
      scanId: scan.id,
      status,
      checkedSlots: allObservations.length,
      changedSlots: changes.changedSlots + confirmationChanges.changedSlots,
      bookingEvents: changes.bookingEvents + confirmationChanges.bookingEvents,
      cancellationEvents: changes.cancellationEvents + confirmationChanges.cancellationEvents,
      startKey,
      endKey,
      errors: allErrors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.competitorScan.update({
      where: { id: scan.id },
      data: { status: "FAILED", error: message.slice(0, 2000), finishedAt: new Date() },
    });
    await createAdminAlert({
      type: SYNERGY_SPACECLOUD_ALERT_TYPE,
      severity: "CRITICAL",
      title: "시너지 스클 일정 점검 실패",
      message,
      dedupeKey: "competitor-synergy-spacecloud-scan-error",
    });
    throw error;
  }
}

export function runCompetitorScan(options: RunOptions): Promise<CompetitorScanResult> {
  if (isRpaPausedForProxy()) {
    const circuit = getRpaProxyCircuitState();
    return Promise.resolve({
      skipped: true,
      status: "PROXY_PAUSED",
      reason: circuit.reason,
    });
  }

  const globalState = globalThis as MonitorGlobal;
  if (globalState.__competitorScanPromise) return globalState.__competitorScanPromise;

  globalState.__competitorScanPromise = (async () => {
    const releaseLock = await acquireMonitorLock();
    if (!releaseLock) {
      const activeScan = await prisma.competitorScan.findFirst({
        where: { status: "RUNNING" },
        orderBy: { startedAt: "desc" },
      });
      return {
        skipped: true,
        scanId: activeScan?.id,
        status: activeScan?.status || "RUNNING",
      };
    }
    try {
      const result = await runScan(options);
      if (
        !result.skipped
        && result.status === "COMPLETED"
        && result.startKey
        && result.endKey
      ) {
        try {
          const spacecloudResult = await runSynergySpacecloudRangeScan({
            startKey: result.startKey,
            endKey: result.endKey,
            mode: "synergy-spacecloud-followup",
          });
          console.log(
            `[Competitor] Synergy SpaceCloud follow-up ${spacecloudResult.skipped ? "skipped" : "done"}: status ${spacecloudResult.status || "-"}, checked ${spacecloudResult.checkedSlots || 0}, changed ${spacecloudResult.changedSlots || 0}`,
          );
        } catch (error) {
          console.error("[Competitor] Synergy SpaceCloud follow-up failed after Naver scan:", error);
        }
      }
      return result;
    } finally {
      await releaseLock();
    }
  })().finally(() => {
    delete globalState.__competitorScanPromise;
  });
  return globalState.__competitorScanPromise;
}

export function runSynergySpacecloudScan(): Promise<CompetitorScanResult> {
  if (isRpaPausedForProxy()) {
    const circuit = getRpaProxyCircuitState();
    return Promise.resolve({
      skipped: true,
      status: "PROXY_PAUSED",
      reason: circuit.reason,
    });
  }

  const globalState = globalThis as MonitorGlobal;
  if (globalState.__competitorScanPromise) return globalState.__competitorScanPromise;

  globalState.__competitorScanPromise = (async () => {
    const releaseLock = await acquireMonitorLock();
    if (!releaseLock) return { skipped: true, status: "RUNNING" };
    try {
      return await runSynergySpacecloudRangeScan();
    } finally {
      await releaseLock();
    }
  })().finally(() => {
    delete globalState.__competitorScanPromise;
  });
  return globalState.__competitorScanPromise;
}
