import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";
import { optionalEnv } from "../rpa/lib/env.mjs";
import { acquireProcessLock } from "../rpa/lib/process-lock.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const full = args.has("--full");
const planOnly = args.has("--plan");
const ensureMissing = args.has("--ensure-missing");
const retryNoBlock = args.has("--retry-no-block");

function textArg(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

const retryStatuses = new Set(
  textArg("--retry-status").split(",").map((value) => value.trim()).filter(Boolean),
);
if (retryNoBlock) retryStatuses.add("no-block");

function numericArg(name, fallback) {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

const limit = Math.floor(numericArg("--limit", 50));
const unresolvedCooldownHours = numericArg("--unresolved-cooldown-hours", 20);
const childTimeoutMs = numericArg("--child-timeout-minutes", 6) * 60 * 1000;
const statePath = resolve(optionalEnv(
  "SPACECLOUD_RECONCILE_STATE_PATH",
  "rpa/.runtime/spacecloud-manual-reconcile-state.json",
));

const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" }),
});

const resolvedStatuses = new Set(["claimed", "already-linked", "created"]);
const attentionStatuses = new Set([
  "blocked-unmatched",
  "covered-unmatched",
  "failed",
  "no-block",
  "timeout",
  "ok-unknown",
]);
const reconcileCheckPrefix = "[RPA_CHECK_REQUIRED] SpaceCloud manual reconciliation:";
const spaceCloudGroupPrefix = "[SPACECLOUD_SYNC_GROUP]";

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed?.version === 1 && parsed.bookings && typeof parsed.bookings === "object") return parsed;
  } catch {
    // First run or an invalid file starts a fresh reconciliation state.
  }
  return { version: 1, bookings: {} };
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

function kstParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function candidateFromReservation(reservation) {
  const bookingNumber = reservation.emailId?.match(/^naver:(\d{9,12})$/)?.[1];
  const room = String(reservation.roomName || "").match(/([123])$/)?.[1];
  const start = kstParts(reservation.startTime);
  const end = kstParts(reservation.endTime);
  const date = `${start.year}-${start.month}-${start.day}`;
  const endDate = `${end.year}-${end.month}-${end.day}`;

  if (!bookingNumber || !room || date !== endDate || !reservation.customerName || !reservation.phone) return null;

  const startClock = `${start.hour}:${start.minute}`;
  const endClock = `${end.hour}:${end.minute}`;
  const identityFingerprint = createHash("sha256")
    .update(`${reservation.customerName}\0${reservation.phone}`)
    .digest("hex")
    .slice(0, 16);
  return {
    reservationId: reservation.id,
    reservationIds: [reservation.id],
    bookingNumber,
    bookingNumbers: [bookingNumber],
    room,
    date,
    start: startClock,
    end: endClock,
    customerName: reservation.customerName,
    phone: reservation.phone,
    identityFingerprint,
    fingerprint: [room, date, startClock, endClock, identityFingerprint].join("|"),
  };
}

function clockMinutes(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  return hour * 60 + minute;
}

function groupAdjacentCandidates(candidates) {
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const key = [candidate.room, candidate.date, candidate.identityFingerprint].join("|");
    const values = byIdentity.get(key) || [];
    values.push(candidate);
    byIdentity.set(key, values);
  }

  const grouped = [];
  for (const values of byIdentity.values()) {
    values.sort((left, right) => clockMinutes(left.start) - clockMinutes(right.start));
    let current = null;

    for (const candidate of values) {
      if (current && clockMinutes(candidate.start) <= clockMinutes(current.end)) {
        if (clockMinutes(candidate.end) > clockMinutes(current.end)) current.end = candidate.end;
        current.reservationIds.push(...candidate.reservationIds);
        current.bookingNumbers.push(...candidate.bookingNumbers);
        continue;
      }

      if (current) grouped.push(current);
      current = {
        ...candidate,
        reservationIds: [...candidate.reservationIds],
        bookingNumbers: [...candidate.bookingNumbers],
      };
    }

    if (current) grouped.push(current);
  }

  return grouped
    .map((candidate) => {
      if (candidate.bookingNumbers.length === 1) return candidate;
      const bookingNumber = candidate.bookingNumbers.join("+");
      return {
        ...candidate,
        bookingNumber,
        fingerprint: [
          candidate.room,
          candidate.date,
          candidate.start,
          candidate.end,
          candidate.identityFingerprint,
          bookingNumber,
        ].join("|"),
      };
    })
    .sort((left, right) =>
      left.date.localeCompare(right.date)
      || left.room.localeCompare(right.room)
      || clockMinutes(left.start) - clockMinutes(right.start)
    );
}

function groupMemoLine(candidate) {
  if (candidate.bookingNumbers.length <= 1) return null;
  return `${spaceCloudGroupPrefix} booking=${candidate.bookingNumber};room=${candidate.room};date=${candidate.date};start=${candidate.start};end=${candidate.end}`;
}

async function updateAttentionMemo(candidate, status) {
  if (!apply) return;
  const groupLine = resolvedStatuses.has(status) ? groupMemoLine(candidate) : null;

  for (const reservationId of candidate.reservationIds) {
    const current = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { memo: true },
    });
    if (!current) continue;

    const remainingLines = (current.memo || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.includes(reconcileCheckPrefix))
      .filter((line) => !line.startsWith(spaceCloudGroupPrefix));
    if (attentionStatuses.has(status)) {
      remainingLines.push(`${reconcileCheckPrefix} ${status}`);
    }
    if (groupLine) remainingLines.push(groupLine);
    const memo = remainingLines.length > 0 ? remainingLines.join("\n") : null;
    if (memo === current.memo) continue;
    await prisma.reservation.update({ where: { id: reservationId }, data: { memo } });
  }
}

function classifyResult(output, result) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if ((result.status ?? 1) !== 0) return "failed";
  if (/"created"\s*:\s*true/.test(output)) return "created";
  if (/"manualBlockClaimed"\s*:\s*true/.test(output)) return "claimed";
  if (/"alreadyLinked"\s*:\s*true/.test(output)) return "already-linked";
  if (/"coveredUnmatched"\s*:\s*true/.test(output)) return "covered-unmatched";
  if (/"manualBlockNeedsIdentity"\s*:\s*true/.test(output)) return "needs-identity";
  if (/"noClaimableManualBlock"\s*:\s*true/.test(output)) {
    return /"targetBlocked"\s*:\s*true/.test(output) ? "blocked-unmatched" : "no-block";
  }
  return "ok-unknown";
}

function shouldSkip(candidate, previous, memberPrevious, nowMs) {
  if (retryStatuses.size > 0) {
    const selected = [previous, ...memberPrevious]
      .some((entry) => retryStatuses.has(entry?.status));
    return selected ? null : "not-selected";
  }
  if (full || !previous || previous.fingerprint !== candidate.fingerprint) return null;
  if (resolvedStatuses.has(previous.status)) return "resolved";

  const checkedAtMs = Date.parse(previous.checkedAt || "");
  const cooldownMs = unresolvedCooldownHours * 60 * 60 * 1000;
  if (Number.isFinite(checkedAtMs) && nowMs - checkedAtMs < cooldownMs) return "cooldown";
  return null;
}

function migrateResolvedFingerprint(candidate, previous) {
  if (!previous || !resolvedStatuses.has(previous.status) || previous.fingerprint === candidate.fingerprint) {
    return false;
  }
  const previousParts = String(previous.fingerprint || "").split("|");
  if (previousParts.length !== 5 || /^[a-f0-9]{16}$/i.test(previousParts[4])) return false;
  const previousSchedule = previousParts.slice(0, 4).join("|");
  const candidateSchedule = candidate.fingerprint.split("|").slice(0, 4).join("|");
  if (previousSchedule !== candidateSchedule) return false;

  previous.fingerprint = candidate.fingerprint;
  previous.fingerprintMigratedAt = new Date().toISOString();
  return true;
}

function runBooking(candidate, { claimOnly }) {
  const childArgs = [
    "rpa/spacecloud-external-reservation.mjs",
    `--room=${candidate.room}`,
    `--date=${candidate.date}`,
    `--start=${candidate.start}`,
    `--end=${candidate.end}`,
    "--mode=close",
    `--booking-number=${candidate.bookingNumber}`,
  ];
  if (claimOnly) childArgs.push("--claim-only");
  if (apply) childArgs.push("--apply");
  if (candidate.customerName) childArgs.push(`--customer-name=${candidate.customerName}`);
  if (candidate.phone) childArgs.push(`--phone=${candidate.phone}`);

  const result = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: childTimeoutMs,
    env: {
      ...process.env,
      RPA_HEADLESS: "false",
      RPA_DELAY_MULTIPLIER: optionalEnv("SPACECLOUD_RECONCILE_DELAY_MULTIPLIER", "0.8"),
      RPA_MIN_RANDOM_DELAY_FLOOR_MS: optionalEnv("SPACECLOUD_RECONCILE_DELAY_FLOOR_MS", "500"),
    },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return { status: classifyResult(output, result) };
}

async function main() {
  const releaseLock = await acquireProcessLock("rpa/.locks/spacecloud-reconcile.lock", {
    label: "SpaceCloud manual-block reconciliation",
    failIfLocked: true,
    staleMs: 2 * 60 * 60 * 1000,
  });

  try {
  const state = readState();
  const now = new Date();
  const reservations = await prisma.reservation.findMany({
    where: {
      source: "naver",
      status: "CONFIRMED",
      emailId: { startsWith: "naver:" },
      endTime: { gte: now },
    },
    select: {
      id: true,
      emailId: true,
      roomName: true,
      customerName: true,
      phone: true,
      startTime: true,
      endTime: true,
    },
    orderBy: { startTime: "asc" },
  });

  const summary = {
    scanned: reservations.length,
    eligible: 0,
    invalidOrMissingIdentity: 0,
    skippedResolved: 0,
    skippedCooldown: 0,
    skippedNotSelected: 0,
    migratedFingerprints: 0,
    attempted: 0,
    pending: 0,
    statuses: {},
    apply,
    ensureMissing,
  };
  const eligibleCandidates = [];

  for (const reservation of reservations) {
    const candidate = candidateFromReservation(reservation);
    if (!candidate) {
      summary.invalidOrMissingIdentity += 1;
      continue;
    }
    summary.eligible += 1;
    eligibleCandidates.push(candidate);
  }

  const groupedCandidates = groupAdjacentCandidates(eligibleCandidates);
  summary.groupedReservations = groupedCandidates
    .filter((candidate) => candidate.bookingNumbers.length > 1)
    .reduce((count, candidate) => count + candidate.bookingNumbers.length, 0);
  summary.groupCandidates = groupedCandidates
    .filter((candidate) => candidate.bookingNumbers.length > 1)
    .length;
  const candidates = [];

  for (const candidate of groupedCandidates) {
    const previous = state.bookings[candidate.bookingNumber];
    const memberPrevious = candidate.bookingNumbers
      .map((bookingNumber) => state.bookings[bookingNumber])
      .filter(Boolean);
    if (migrateResolvedFingerprint(candidate, previous)) summary.migratedFingerprints += 1;
    const skipReason = shouldSkip(candidate, previous, memberPrevious, now.getTime());
    if (skipReason === "resolved") {
      summary.skippedResolved += 1;
      continue;
    }
    if (skipReason === "cooldown") {
      summary.skippedCooldown += 1;
      continue;
    }
    if (skipReason === "not-selected") {
      summary.skippedNotSelected += 1;
      continue;
    }
    candidates.push(candidate);
  }

  if (summary.migratedFingerprints > 0) saveState(state);

  summary.pending = candidates.length;
  if (planOnly) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const candidate of candidates.slice(0, limit)) {
    summary.attempted += 1;
    console.log(
      `[SpaceCloud reconcile] Check booking ${candidate.bookingNumber}: room ${candidate.room}, ${candidate.date} ${candidate.start}-${candidate.end}.`,
    );

    let { status } = runBooking(candidate, { claimOnly: true });
    if (apply && ensureMissing && status === "no-block") {
      console.log(`[SpaceCloud reconcile] Booking ${candidate.bookingNumber}: no block; create it now.`);
      ({ status } = runBooking(candidate, { claimOnly: false }));
    }
    summary.statuses[status] = (summary.statuses[status] || 0) + 1;
    state.bookings[candidate.bookingNumber] = {
      fingerprint: candidate.fingerprint,
      status,
      checkedAt: new Date().toISOString(),
    };
    for (const bookingNumber of candidate.bookingNumbers) {
      state.bookings[bookingNumber] = {
        fingerprint: candidate.fingerprint,
        status,
        checkedAt: new Date().toISOString(),
        groupBookingNumber: candidate.bookingNumber,
      };
    }
    await updateAttentionMemo(candidate, status);
    saveState(state);
    console.log(`[SpaceCloud reconcile] Booking ${candidate.bookingNumber}: ${status}.`);
  }

  state.lastRunAt = new Date().toISOString();
  state.lastRunApply = apply;
  saveState(state);
  console.log(JSON.stringify(summary, null, 2));

    if ((summary.statuses.failed || 0) + (summary.statuses.timeout || 0) > 0) process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main()
  .catch((error) => {
    console.error("SpaceCloud manual-block reconciliation failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
