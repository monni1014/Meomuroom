import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma";
import type { ParsedReservation } from "./email-parser";
import { clearRpaPendingForReservation, RPA_PENDING_MARKER } from "./rpa-reservation-state";

const execFileAsync = promisify(execFile);

const FAST_SLOT_RPA_ENV = {
  RPA_DELAY_MULTIPLIER: "0.42",
  RPA_MIN_RANDOM_DELAY_FLOOR_MS: "250",
  RPA_LOCK_RETRY_MIN_MS: "300",
  RPA_LOCK_RETRY_MAX_MS: "700",
};

const FAST_SPACECLOUD_SLOT_RPA_ENV = {
  RPA_DELAY_MULTIPLIER: "0.55",
  RPA_MIN_RANDOM_DELAY_FLOOR_MS: "350",
  RPA_LOCK_RETRY_MIN_MS: "300",
  RPA_LOCK_RETRY_MAX_MS: "700",
};

const ROOM_PRODUCT_URL: Record<string, string> = {
  "1": "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail",
  "2": "https://partner.booking.naver.com/bizes/1473933/biz-items/7007523/detail",
  "3": "https://partner.booking.naver.com/bizes/1473933/biz-items/7858758/detail",
};

const RPA_CHECK_MARKER = "[RPA_CHECK_REQUIRED]";
const RPA_TIME_OVERRIDE_MARKER = "[RPA_TIME_OVERRIDE]";
const SPACECLOUD_SYNC_GROUP_MARKER = "[SPACECLOUD_SYNC_GROUP]";

type NaverDetailResult = {
  bookingStatus?: string | null;
  bookingNumber?: string | null;
  customerName?: string | null;
  phone?: string | null;
  productName?: string | null;
  useDateTime?: string | null;
  useDateText?: string | null;
  useTimeText?: string | null;
  quantity?: string | null;
  paymentStatus?: string | null;
  priceText?: string | null;
  screenshot?: string | null;
  visibleTextSample?: string | null;
};

type NormalizedNaverReservation = {
  bookingNumber: string;
  room: "1" | "2" | "3";
  roomName: string;
  customerName: string;
  phone: string | null;
  startTime: Date;
  endTime: Date;
  dateValue: string;
  startClock: string;
  endClock: string;
  price: number;
  discount: number;
  headCount: number;
  status: "CONFIRMED" | "CANCELLED";
  paymentMethod: string;
  isPaid: boolean;
};

type SlotActionResult = {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
};

type SlotSegment = {
  startTime: Date;
  endTime: Date;
};

type SpaceCloudSyncGroup = {
  bookingNumber: string;
  bookingNumbers: string[];
  room: "1" | "2" | "3";
  dateValue: string;
  startClock: string;
  endClock: string;
};

type RpaRecheckGlobal = typeof globalThis & {
  __naverSlotRpaIssueRecheckedAt?: Map<string, number>;
  __naverStatusCheckedAt?: Map<string, number>;
};

function toKstDateValue(date: Date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function toClock(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.hour}:${map.minute}`;
}

function toSlotEndClock(startTime: Date, endTime: Date) {
  const endClock = toClock(endTime);
  if (
    endClock === "00:00"
    && endTime.getTime() > startTime.getTime()
    && toKstDateValue(startTime) !== toKstDateValue(endTime)
  ) {
    return "24:00";
  }
  return endClock;
}

function parseAmount(value?: string | null) {
  if (!value) return 0;
  return Number(value.replace(/[^\d]/g, "")) || 0;
}

function parseCancellationFeeFromDetail(detail: NaverDetailResult) {
  const text = detail.visibleTextSample || "";
  const match = text.match(/(?:\uCDE8\uC18C\uC218\uC218\uB8CC|\uD658\uBD88\uC218\uC218\uB8CC)\s*([\d,]+)\s*\uC6D0/);
  return match ? Number(match[1].replace(/,/g, "")) : 0;
}

function naverBookingNumberFromEmailId(emailId?: string | null) {
  const match = (emailId || "").match(/^naver:(\d+)$/);
  return match?.[1] || null;
}

function parseSpaceCloudSyncGroup(memo?: string | null): SpaceCloudSyncGroup | null {
  const line = (memo || "")
    .split(/\r?\n/)
    .find((value) => value.startsWith(SPACECLOUD_SYNC_GROUP_MARKER));
  if (!line) return null;

  const match = line.match(
    /^\[SPACECLOUD_SYNC_GROUP\] booking=([0-9+]+);room=([123]);date=(\d{4}-\d{2}-\d{2});start=(\d{2}:\d{2});end=(\d{2}:\d{2})$/,
  );
  if (!match) return null;

  const bookingNumbers = match[1].split("+").filter((value) => /^\d{9,12}$/.test(value));
  if (bookingNumbers.length < 2) return null;

  return {
    bookingNumber: match[1],
    bookingNumbers,
    room: match[2] as "1" | "2" | "3",
    dateValue: match[3],
    startClock: match[4],
    endClock: match[5],
  };
}

function dateFromKstClock(dateValue: string, clock: string) {
  const [hour, minute] = clock.split(":").map(Number);
  if (hour === 24) {
    const value = new Date(`${dateValue}T00:00:00+09:00`);
    value.setDate(value.getDate() + 1);
    return value;
  }
  return new Date(
    `${dateValue}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`,
  );
}

function formatSpaceCloudSyncGroup(group: SpaceCloudSyncGroup) {
  return `${SPACECLOUD_SYNC_GROUP_MARKER} booking=${group.bookingNumber};room=${group.room};date=${group.dateValue};start=${group.startClock};end=${group.endClock}`;
}

function parseHeadCount(value?: string | null) {
  if (!value) return 1;
  return Number(value.replace(/[^\d]/g, "")) || 1;
}

function parseRoom(productName?: string | null): "1" | "2" | "3" {
  if (productName?.includes("3")) return "3";
  if (productName?.includes("2")) return "2";
  if (productName?.includes("1")) return "1";
  throw new Error(`Unknown Naver room product: ${productName || "(empty)"}`);
}

function parseRoomFromRoomName(roomName?: string | null): "1" | "2" | "3" {
  if (roomName === "머무룸3") return "3";
  if (roomName === "머무룸2") return "2";
  if (roomName === "머무룸1") return "1";
  throw new Error(`Unknown reservation room: ${roomName || "(empty)"}`);
}

function parseKoreanTimePrefix(prefix: string, hourText: string, minuteText: string) {
  let hour = Number(hourText);
  const minute = Number(minuteText);

  if (prefix === "오후" && hour !== 12) hour += 12;
  if (prefix === "오전" && hour === 12) hour = 0;

  return { hour, minute };
}

function parseNaverDateTime(dateText?: string | null, timeText?: string | null) {
  const dateMatch = dateText?.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  const timeMatch = timeText?.match(/(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);

  if (!dateMatch || !timeMatch) {
    throw new Error(`Could not parse Naver date/time: ${dateText || ""} ${timeText || ""}`);
  }

  const [, year, month, day] = dateMatch;
  const start = parseKoreanTimePrefix(timeMatch[1], timeMatch[2], timeMatch[3]);
  const end = parseKoreanTimePrefix(timeMatch[4], timeMatch[5], timeMatch[6]);
  const dateValue = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  const startTime = new Date(`${dateValue}T${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}:00+09:00`);
  const endTime = new Date(`${dateValue}T${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}:00+09:00`);
  // Naver's booking list represents a midnight endpoint as 23:59.
  if (end.hour === 23 && end.minute === 59) {
    endTime.setMinutes(endTime.getMinutes() + 1);
  }
  if (endTime.getTime() <= startTime.getTime()) {
    endTime.setDate(endTime.getDate() + 1);
  }

  return { startTime, endTime };
}

function extractBookingId(subject: string, text: string, html?: string | false) {
  const combined = `${subject}\n${text}\n${html || ""}`;
  const urlMatch = combined.match(/booking-list-view\/bookings\/(\d{9,12})/);
  if (urlMatch) return urlMatch[1];

  const labelMatch = combined.match(/예약\s*번호[^\d]*(\d{9,12})/);
  if (labelMatch) return labelMatch[1];

  const fallbackMatch = combined.match(/\b\d{10}\b/);
  return fallbackMatch?.[0] || null;
}

function parseJsonFromStdout(stdout: string) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`RPA did not return JSON. stdout=${stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as NaverDetailResult;
}

async function runNodeScript(args: string[], timeout = 180_000, envOverrides: Record<string, string> = {}) {
  const result = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...envOverrides },
    timeout,
    maxBuffer: 1024 * 1024 * 5,
  });
  return result.stdout;
}

function shouldUseSpaceCloudXvfb() {
  const explicit = process.env.SPACECLOUD_RPA_USE_XVFB?.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(explicit || "")) return false;
  if (["1", "true", "yes", "on"].includes(explicit || "")) return true;
  return process.platform === "linux";
}

async function runSpaceCloudNodeScript(
  args: string[],
  timeout = 360_000,
  envOverrides: Record<string, string> = {},
) {
  if (!shouldUseSpaceCloudXvfb()) {
    return runNodeScript(args, timeout, envOverrides);
  }

  const result = await execFileAsync("xvfb-run", ["-a", process.execPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...envOverrides,
      RPA_HEADLESS: "false",
    },
    timeout,
    maxBuffer: 1024 * 1024 * 5,
  });
  return result.stdout;
}

async function markRpaCheckRequired(reservationId: string, reason: string) {
  const clippedReason = reason.replace(/\s+/g, " ").trim().slice(0, 1200);
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });

  if (!current) return;
  if (current.memo?.includes(clippedReason)) return;

  const memo = [current.memo, `${RPA_CHECK_MARKER} ${clippedReason}`]
    .filter(Boolean)
    .join("\n");

  await prisma.reservation.update({
    where: { id: reservationId },
    data: { memo },
  });
}

function removeRpaCheckLines(memo: string | null, shouldRemove: (line: string) => boolean = () => true) {
  if (!memo?.includes(RPA_CHECK_MARKER)) return memo;

  const remaining = memo
    .split(/\r?\n/)
    .filter((line) => !(line.includes(RPA_CHECK_MARKER) && shouldRemove(line)))
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return remaining.length > 0 ? remaining.join("\n") : null;
}

async function clearRpaCheckRequired(reservationId: string, shouldRemove?: (line: string) => boolean) {
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });

  if (!current?.memo?.includes(RPA_CHECK_MARKER)) return;

  const memo = removeRpaCheckLines(current.memo, shouldRemove);
  if (memo === current.memo) return;

  await prisma.reservation.update({
    where: { id: reservationId },
    data: { memo },
  });
}

async function readNaverDetail(bookingId: string, dateValue?: string) {
  const args = ["rpa/naver-read-booking-detail.mjs", bookingId];
  if (dateValue) args.push(`--date=${dateValue}`);
  return parseJsonFromStdout(await runNodeScript(args));
}

function normalizeDetail(detail: NaverDetailResult, fallbackDiscount = 0): NormalizedNaverReservation {
  if (!detail.bookingNumber) throw new Error("Naver detail missing booking number.");
  if (!detail.customerName) throw new Error("Naver detail missing customer name.");

  const { startTime, endTime } = parseNaverDateTime(detail.useDateText, detail.useTimeText);
  const room = parseRoom(detail.productName);
  const status = detail.bookingStatus?.includes("취소") ? "CANCELLED" : "CONFIRMED";

  return {
    bookingNumber: detail.bookingNumber,
    room,
    roomName: `머무룸${room}`,
    customerName: detail.customerName,
    phone: detail.phone || null,
    startTime,
    endTime,
    dateValue: toKstDateValue(startTime),
    startClock: toClock(startTime),
    endClock: toSlotEndClock(startTime, endTime),
    price: parseAmount(detail.priceText),
    discount: fallbackDiscount,
    headCount: parseHeadCount(detail.quantity),
    status,
    paymentMethod: "온라인",
    isPaid: detail.paymentStatus === "결제완료",
  };
}

function normalizeParsedReservation(parsed: ParsedReservation, bookingId?: string | null): NormalizedNaverReservation {
  const room = parseRoom(parsed.roomName);

  return {
    bookingNumber: bookingId || parsed.emailId,
    room,
    roomName: `머무룸${room}`,
    customerName: parsed.customerName,
    phone: null,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    dateValue: toKstDateValue(parsed.startTime),
    startClock: toClock(parsed.startTime),
    endClock: toSlotEndClock(parsed.startTime, parsed.endTime),
    price: parsed.isCancelled ? (parsed.refundFee ?? 0) : parsed.price,
    discount: parsed.discount ?? 0,
    headCount: parsed.headCount,
    status: parsed.isCancelled ? "CANCELLED" : "CONFIRMED",
    paymentMethod: "온라인",
    isPaid: true,
  };
}

function isMaskedOrFallbackName(name: string | null | undefined) {
  if (!name) return true;
  return name.includes("*") || name.includes("네이버 예약");
}

async function findExistingReservationByParsedEmail(parsed: ParsedReservation) {
  return prisma.reservation.findFirst({
    where: {
      source: "naver",
      roomName: parsed.roomName,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
    },
  });
}

async function upsertNaverReservation(item: NormalizedNaverReservation, messageId: string, receivedAt?: Date) {
  const reservationEmailId = /^\d+$/.test(item.bookingNumber) ? `naver:${item.bookingNumber}` : messageId;
  const existing =
    (await prisma.reservation.findFirst({
      where: {
        OR: [
          { emailId: messageId },
          { emailId: reservationEmailId },
          {
            source: "naver",
            roomName: item.roomName,
            startTime: item.startTime,
            endTime: item.endTime,
          },
        ],
      },
      include: { usageLog: true },
      orderBy: { createdAt: "asc" },
    })) || null;

  if (existing) {
    const preserveOperationalTime = existing.memo?.includes(RPA_TIME_OVERRIDE_MARKER) === true;
    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        emailId: reservationEmailId,
        source: "naver",
        roomName: item.roomName,
        customerName: item.customerName,
        phone: item.phone,
        startTime: preserveOperationalTime ? existing.startTime : item.startTime,
        endTime: preserveOperationalTime ? existing.endTime : item.endTime,
        price: item.price,
        discount: item.discount,
        status: item.status,
        paymentMethod: item.paymentMethod,
        isPaid: item.isPaid,
        usageLog: existing.usageLog
          ? { update: { reservedHeadCount: item.headCount } }
          : { create: { headCount: item.headCount, reservedHeadCount: item.headCount, purpose: null } },
      },
      include: { usageLog: true },
    });

    await clearRpaPendingForReservation(updated.id);
    return { reservation: updated, created: false };
  }

  const created = await prisma.reservation.create({
    data: {
      emailId: reservationEmailId,
      source: "naver",
      roomName: item.roomName,
      customerName: item.customerName,
      phone: item.phone,
      startTime: item.startTime,
      endTime: item.endTime,
      createdAt: receivedAt || new Date(),
      price: item.price,
      discount: item.discount,
      status: item.status,
      paymentMethod: item.paymentMethod,
      isPaid: item.isPaid,
      usageLog: {
        create: {
          headCount: item.headCount,
          reservedHeadCount: item.headCount,
          purpose: null,
        },
      },
    },
    include: { usageLog: true },
  });

  return { reservation: created, created: true };
}

async function findCancellationTarget(item: NormalizedNaverReservation, messageId: string) {
  const reservationEmailId = /^\d+$/.test(item.bookingNumber) ? `naver:${item.bookingNumber}` : messageId;
  const reservations = await prisma.reservation.findMany({
    where: {
      OR: [
        { emailId: messageId },
        { emailId: reservationEmailId },
        {
          source: "naver",
          roomName: item.roomName,
          startTime: item.startTime,
          endTime: item.endTime,
        },
      ],
    },
    include: { usageLog: true },
    orderBy: { createdAt: "asc" },
  });

  return reservations.find((reservation) => reservation.status !== "CANCELLED") || reservations[0] || null;
}

async function deleteDetachedCancellationPending(messageId: string, keptReservationId: string) {
  const pending = await prisma.reservation.findUnique({
    where: { emailId: messageId },
    select: { id: true, source: true, status: true, memo: true },
  });

  if (
    !pending
    || pending.id === keptReservationId
    || pending.source !== "naver"
    || pending.status !== "CANCELLED"
    || !pending.memo?.includes(RPA_PENDING_MARKER)
  ) return;

  await prisma.$transaction([
    prisma.usageLog.deleteMany({ where: { reservationId: pending.id } }),
    prisma.reservation.deleteMany({
      where: {
        id: pending.id,
        emailId: messageId,
        memo: { contains: RPA_PENDING_MARKER },
      },
    }),
  ]);
  console.log(`[NaverRPA] Removed detached cancellation pending row: ${pending.id}`);
}

async function cancelNaverReservation(
  item: NormalizedNaverReservation,
  messageId: string,
  refundFee: number,
  receivedAt?: Date,
) {
  const existing = await findCancellationTarget(item, messageId);
  const cancellationPrice = refundFee;
  const reservationEmailId = /^\d+$/.test(item.bookingNumber) ? `naver:${item.bookingNumber}` : messageId;

  if (existing) {
    const wasPending = Boolean(existing.memo?.includes(RPA_PENDING_MARKER));
    const hasObsoleteCloseCheck = Boolean(
      existing.memo?.split(/\r?\n/).some((line) => line.includes(RPA_CHECK_MARKER) && isObsoleteCloseCheckLine(line)),
    );
    if (existing.status === "CANCELLED" && existing.price === cancellationPrice && !wasPending && !hasObsoleteCloseCheck) {
      return { reservation: existing, created: false, changed: false };
    }

    const preserveOperationalTime = existing.memo?.includes(RPA_TIME_OVERRIDE_MARKER) === true;
    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        emailId: reservationEmailId,
        source: "naver",
        roomName: item.roomName,
        customerName: isMaskedOrFallbackName(item.customerName) ? existing.customerName : item.customerName,
        phone: item.phone || existing.phone,
        startTime: preserveOperationalTime ? existing.startTime : item.startTime,
        endTime: preserveOperationalTime ? existing.endTime : item.endTime,
        price: cancellationPrice,
        status: "CANCELLED",
        paymentMethod: item.paymentMethod,
        isPaid: cancellationPrice > 0,
        usageLog: existing.usageLog
          ? { update: { reservedHeadCount: item.headCount } }
          : { create: { headCount: item.headCount, reservedHeadCount: item.headCount, purpose: null } },
      },
      include: { usageLog: true },
    });

    await clearRpaPendingForReservation(updated.id);
    await deleteDetachedCancellationPending(messageId, updated.id);
    return { reservation: updated, created: false, changed: true };
  }

  const created = await prisma.reservation.create({
    data: {
      emailId: reservationEmailId,
      source: "naver",
      roomName: item.roomName,
      customerName: item.customerName,
      phone: item.phone,
      startTime: item.startTime,
      endTime: item.endTime,
      createdAt: receivedAt || new Date(),
      price: cancellationPrice,
      status: "CANCELLED",
      paymentMethod: item.paymentMethod,
      isPaid: cancellationPrice > 0,
      usageLog: {
        create: {
          headCount: item.headCount,
          reservedHeadCount: item.headCount,
          purpose: null,
        },
      },
    },
    include: { usageLog: true },
  });

  await deleteDetachedCancellationPending(messageId, created.id);
  return { reservation: created, created: true, changed: true };
}

function canSetSlot(item: NormalizedNaverReservation) {
  return item.startClock.endsWith(":00")
    && item.endClock.endsWith(":00")
    && (
      toKstDateValue(item.startTime) === toKstDateValue(item.endTime)
      || item.endClock === "24:00"
    );
}

function cloneSlotItem(item: NormalizedNaverReservation, segment: SlotSegment): NormalizedNaverReservation {
  return {
    ...item,
    startTime: segment.startTime,
    endTime: segment.endTime,
    dateValue: toKstDateValue(segment.startTime),
    startClock: toClock(segment.startTime),
    endClock: toSlotEndClock(segment.startTime, segment.endTime),
  };
}

function getHourlySlotSegments(item: NormalizedNaverReservation) {
  const segments: SlotSegment[] = [];
  const hourMs = 60 * 60 * 1000;
  let cursor = item.startTime.getTime();
  const end = item.endTime.getTime();

  while (cursor < end) {
    const next = Math.min(cursor + hourMs, end);
    segments.push({
      startTime: new Date(cursor),
      endTime: new Date(next),
    });
    cursor = next;
  }

  return segments;
}

function mergeAdjacentSegments(segments: SlotSegment[]) {
  const sorted = [...segments].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const merged: SlotSegment[] = [];

  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.endTime.getTime() === segment.startTime.getTime()) {
      last.endTime = segment.endTime;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

async function findConfirmedSlotOverlaps(item: NormalizedNaverReservation, reservationId: string) {
  return prisma.reservation.findMany({
    where: {
      id: { not: reservationId },
      roomName: item.roomName,
      status: "CONFIRMED",
      startTime: { lt: item.endTime },
      endTime: { gt: item.startTime },
    },
    include: { usageLog: true },
    orderBy: { startTime: "asc" },
  });
}

async function getOpenableSlotSegments(item: NormalizedNaverReservation, reservationId: string) {
  const confirmedOverlaps = await findConfirmedSlotOverlaps(item, reservationId);
  const segments = getHourlySlotSegments(item);
  return segments.filter((segment) =>
    !confirmedOverlaps.some((reservation) =>
      reservation.startTime.getTime() < segment.endTime.getTime()
      && reservation.endTime.getTime() > segment.startTime.getTime()
    )
  );
}

async function buildNaverSlotItems(item: NormalizedNaverReservation, mode: "close" | "open", reservationId: string) {
  if (mode === "close") return [item];

  const openableSegments = await getOpenableSlotSegments(item, reservationId);
  return mergeAdjacentSegments(openableSegments).map((segment) => cloneSlotItem(item, segment));
}

function isSlotRpaIssueMemo(memo?: string | null) {
  if (!memo?.includes(RPA_CHECK_MARKER)) return false;
  return memo
    .split(/\r?\n/)
    .some((line) =>
      line.includes(RPA_CHECK_MARKER)
      && (isNaverSlotCheckLine(line) || isSpaceCloudExternalCheckLine(line)),
    );
}

function normalizeReservationForSlotRecheck(reservation: {
  id: string;
  emailId: string | null;
  roomName: string;
  customerName: string | null;
  phone: string | null;
  startTime: Date;
  endTime: Date;
  price: number;
  discount: number;
  status: string;
  paymentMethod: string | null;
  isPaid: boolean;
  isNoShow: boolean;
  usageLog: { reservedHeadCount: number; headCount: number } | null;
}): NormalizedNaverReservation {
  const room = parseRoomFromRoomName(reservation.roomName);

  return {
    bookingNumber: reservation.emailId || reservation.id,
    room,
    roomName: `머무룸${room}`,
    customerName: reservation.customerName || "",
    phone: reservation.phone,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    dateValue: toKstDateValue(reservation.startTime),
    startClock: toClock(reservation.startTime),
    endClock: toSlotEndClock(reservation.startTime, reservation.endTime),
    price: reservation.price,
    discount: reservation.discount,
    headCount: reservation.usageLog?.reservedHeadCount || reservation.usageLog?.headCount || 1,
    status: reservation.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED",
    paymentMethod: reservation.paymentMethod || "온라인",
    isPaid: reservation.isPaid,
  };
}

function getRpaRecheckMap() {
  const g = globalThis as RpaRecheckGlobal;
  g.__naverSlotRpaIssueRecheckedAt ??= new Map<string, number>();
  return g.__naverSlotRpaIssueRecheckedAt;
}

function getNaverStatusCheckMap() {
  const g = globalThis as RpaRecheckGlobal;
  g.__naverStatusCheckedAt ??= new Map<string, number>();
  return g.__naverStatusCheckedAt;
}

function naverStatusCheckCooldownMs() {
  return 12 * 60 * 60 * 1000;
}

function isNaverSlotCheckLine(line: string) {
  return [
    "Naver slot",
    "Unsupported Naver slot time",
    "Unsupported slot time",
    "naver-toggle-slots",
    "Could not navigate",
    "Could not find visual toggle",
    "Unsafe save blocked",
  ].some((pattern) => line.includes(pattern));
}

function isSpaceCloudExternalCheckLine(line: string) {
  return [
    "SpaceCloud external",
    "SpaceCloud grouped external",
    "SpaceCloud manual reconciliation",
    "spacecloud-external-reservation",
    "SpaceCloud login required",
    "SpaceCloud product",
    "SpaceCloud calendar",
  ].some((pattern) => line.includes(pattern));
}

function isObsoleteCloseCheckLine(line: string) {
  return line.includes("Naver slot close failed")
    || line.includes("SpaceCloud external reservation close failed");
}

function hasCheckLine(memo: string | null | undefined, matcher: (line: string) => boolean) {
  if (!memo?.includes(RPA_CHECK_MARKER)) return false;
  return memo
    .split(/\r?\n/)
    .some((line) => line.includes(RPA_CHECK_MARKER) && matcher(line));
}

async function setNaverSlot(item: NormalizedNaverReservation, mode: "close" | "open", reservationId?: string) {
  if (!canSetSlot(item)) {
    const reason = `Unsupported Naver slot time ${item.dateValue} ${item.startClock}-${item.endClock}`;
    if (reservationId) await markRpaCheckRequired(reservationId, reason);
    return { ok: false, skipped: true, reason };
  }

  const productUrl = ROOM_PRODUCT_URL[item.room];
  try {
    await runNodeScript([
      "rpa/naver-toggle-slots.mjs",
      `--room=${item.room}`,
      `--date=${item.dateValue}`,
      `--start=${item.startClock}`,
      `--end=${item.endClock}`,
      `--mode=${mode}`,
      `--product-url=${productUrl}`,
      "--apply",
    ], 240_000, FAST_SLOT_RPA_ENV);

    if (reservationId) await clearRpaCheckRequired(reservationId, isNaverSlotCheckLine);
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reservationId) await markRpaCheckRequired(reservationId, `Naver slot ${mode} failed: ${reason}`);
    return { ok: false, skipped: false, reason };
  }
}

async function setSpaceCloudExternalReservation(
  item: NormalizedNaverReservation,
  mode: "close" | "open",
  reservationId?: string,
  options: {
    allowStillBlockedAfterDelete?: boolean;
    claimUnlabelledBeforeDelete?: boolean;
  } = {},
) {
  if (!canSetSlot(item)) {
    const reason = `Unsupported SpaceCloud external reservation time ${item.dateValue} ${item.startClock}-${item.endClock}`;
    if (reservationId) await markRpaCheckRequired(reservationId, reason);
    return { ok: false, skipped: true, reason };
  }

  const bookingNumber = item.bookingNumber || reservationId || `${item.dateValue}-${item.startClock}-${item.endClock}`;

  try {
    const args = [
      "rpa/spacecloud-external-reservation.mjs",
      `--room=${item.room}`,
      `--date=${item.dateValue}`,
      `--start=${item.startClock}`,
      `--end=${item.endClock}`,
      `--mode=${mode}`,
      `--booking-number=${bookingNumber}`,
      "--apply",
    ];
    if (options.allowStillBlockedAfterDelete) args.push("--allow-still-blocked-after-delete");
    if (options.claimUnlabelledBeforeDelete) args.push("--claim-unlabelled-before-delete");
    if (item.customerName) args.push(`--customer-name=${item.customerName}`);
    if (item.phone) args.push(`--phone=${item.phone}`);

    await runSpaceCloudNodeScript(args, 360_000, FAST_SPACECLOUD_SLOT_RPA_ENV);

    if (reservationId) await clearRpaCheckRequired(reservationId, isSpaceCloudExternalCheckLine);
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reservationId) {
      await markRpaCheckRequired(reservationId, `SpaceCloud external reservation ${mode} failed: ${reason}`);
    }
    return { ok: false, skipped: false, reason };
  }
}

async function resizeSpaceCloudExternalReservation(
  currentItem: NormalizedNaverReservation,
  desiredItem: NormalizedNaverReservation,
  reservationId?: string,
) {
  if (!canSetSlot(currentItem) || !canSetSlot(desiredItem)) {
    const reason = `Unsupported SpaceCloud grouped reservation resize ${currentItem.dateValue} ${currentItem.startClock}-${currentItem.endClock} -> ${desiredItem.startClock}-${desiredItem.endClock}`;
    if (reservationId) await markRpaCheckRequired(reservationId, reason);
    return { ok: false, skipped: true, reason };
  }

  try {
    const args = [
      "rpa/spacecloud-external-reservation.mjs",
      `--room=${currentItem.room}`,
      `--date=${currentItem.dateValue}`,
      `--start=${currentItem.startClock}`,
      `--end=${currentItem.endClock}`,
      "--mode=resize",
      `--new-start=${desiredItem.startClock}`,
      `--new-end=${desiredItem.endClock}`,
      `--booking-number=${currentItem.bookingNumber}`,
      "--apply",
    ];
    if (currentItem.customerName) args.push(`--customer-name=${currentItem.customerName}`);
    if (currentItem.phone) args.push(`--phone=${currentItem.phone}`);

    await runSpaceCloudNodeScript(args, 360_000, FAST_SPACECLOUD_SLOT_RPA_ENV);
    if (reservationId) await clearRpaCheckRequired(reservationId, isSpaceCloudExternalCheckLine);
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reservationId) {
      await markRpaCheckRequired(
        reservationId,
        `SpaceCloud grouped external reservation resize failed: ${reason}`,
      );
    }
    return { ok: false, skipped: false, reason };
  }
}

function groupSlotItem(
  item: NormalizedNaverReservation,
  group: SpaceCloudSyncGroup,
  startClock = group.startClock,
  endClock = group.endClock,
): NormalizedNaverReservation {
  return {
    ...item,
    bookingNumber: group.bookingNumber,
    room: group.room,
    dateValue: group.dateValue,
    startClock,
    endClock,
    startTime: dateFromKstClock(group.dateValue, startClock),
    endTime: dateFromKstClock(group.dateValue, endClock),
  };
}

function normalizedGroupIdentity(customerName: string | null, phone: string | null) {
  return [
    String(customerName || "").normalize("NFKC").trim().toLowerCase(),
    String(phone || "").replace(/\D/g, ""),
  ].join("|");
}

async function replaceSpaceCloudGroupMarker(
  bookingNumbers: string[],
  nextGroup: SpaceCloudSyncGroup | null,
) {
  const reservations = await prisma.reservation.findMany({
    where: { emailId: { in: bookingNumbers.map((value) => `naver:${value}`) } },
    select: { id: true, memo: true },
  });
  const nextLine = nextGroup ? formatSpaceCloudSyncGroup(nextGroup) : null;
  const updates = reservations.flatMap((reservation) => {
    const lines = (reservation.memo || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.startsWith(SPACECLOUD_SYNC_GROUP_MARKER));
    if (nextLine) lines.push(nextLine);
    const memo = lines.length > 0 ? lines.join("\n") : null;
    if (memo === reservation.memo) return [];
    return [prisma.reservation.update({ where: { id: reservation.id }, data: { memo } })];
  });
  if (updates.length > 0) await prisma.$transaction(updates);
  return reservations.map((reservation) => reservation.id);
}

async function runSpaceCloudGroupedReservationAction(
  item: NormalizedNaverReservation,
  group: SpaceCloudSyncGroup,
  reservationId: string,
): Promise<SlotActionResult> {
  if (item.room !== group.room || item.dateValue !== group.dateValue) {
    return {
      ok: false,
      skipped: true,
      reason: "SpaceCloud grouped external reservation metadata no longer matches the reservation room/date. The existing block was kept closed.",
    };
  }

  const members = await prisma.reservation.findMany({
    where: { emailId: { in: group.bookingNumbers.map((value) => `naver:${value}`) } },
    select: {
      id: true,
      roomName: true,
      customerName: true,
      phone: true,
      startTime: true,
      endTime: true,
      status: true,
      isNoShow: true,
    },
    orderBy: { startTime: "asc" },
  });

  if (members.length !== group.bookingNumbers.length) {
    return {
      ok: false,
      skipped: true,
      reason: "SpaceCloud grouped external reservation membership is incomplete. The existing block was kept closed.",
    };
  }

  const identity = normalizedGroupIdentity(members[0]?.customerName || null, members[0]?.phone || null);
  const invalidMember = members.some((member) =>
    parseRoomFromRoomName(member.roomName) !== group.room
    || toKstDateValue(member.startTime) !== group.dateValue
    || normalizedGroupIdentity(member.customerName, member.phone) !== identity
  );
  if (invalidMember) {
    return {
      ok: false,
      skipped: true,
      reason: "SpaceCloud grouped external reservation identity changed. The existing block was kept closed.",
    };
  }

  const activeMembers = members
    .filter((member) => member.status === "CONFIRMED" && !member.isNoShow)
    .sort((left, right) => left.startTime.getTime() - right.startTime.getTime());
  const currentGroupItem = groupSlotItem(item, group);

  if (activeMembers.length === 0) {
    const deleted = await setSpaceCloudExternalReservation(
      currentGroupItem,
      "open",
      reservationId,
    );
    if (!deleted.ok) return deleted;

    const memberIds = await replaceSpaceCloudGroupMarker(group.bookingNumbers, null);
    for (const memberId of memberIds) {
      await clearRpaCheckRequired(memberId, isSpaceCloudExternalCheckLine);
    }
    return deleted;
  }

  const desiredStart = activeMembers[0].startTime;
  let desiredEnd = activeMembers[0].endTime;
  for (const member of activeMembers.slice(1)) {
    if (member.startTime.getTime() > desiredEnd.getTime()) {
      return {
        ok: false,
        skipped: true,
        reason: "SpaceCloud grouped external reservation became disconnected. The wider existing block was kept closed for manual review.",
      };
    }
    if (member.endTime.getTime() > desiredEnd.getTime()) desiredEnd = member.endTime;
  }

  const desiredStartClock = toClock(desiredStart);
  const desiredEndClock = toSlotEndClock(desiredStart, desiredEnd);
  if (desiredStartClock === group.startClock && desiredEndClock === group.endClock) {
    return { ok: true, skipped: true, reason: null };
  }

  const desiredItem = groupSlotItem(item, group, desiredStartClock, desiredEndClock);
  const resized = await resizeSpaceCloudExternalReservation(
    currentGroupItem,
    desiredItem,
    reservationId,
  );
  if (!resized.ok) return resized;

  const nextGroup = {
    ...group,
    startClock: desiredStartClock,
    endClock: desiredEndClock,
  };
  const memberIds = await replaceSpaceCloudGroupMarker(group.bookingNumbers, nextGroup);
  for (const memberId of memberIds) {
    await clearRpaCheckRequired(memberId, isSpaceCloudExternalCheckLine);
  }
  return resized;
}

async function runSpaceCloudSlotAction(
  item: NormalizedNaverReservation,
  mode: "close" | "open",
  reservationId: string,
  options: { claimUnlabelledBeforeDelete?: boolean } = {},
): Promise<SlotActionResult> {
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });
  const group = parseSpaceCloudSyncGroup(current?.memo);
  if (group) {
    return runSpaceCloudGroupedReservationAction(item, group, reservationId);
  }

  if (mode === "close") {
    return setSpaceCloudExternalReservation(item, mode, reservationId);
  }

  const overlaps = await findConfirmedSlotOverlaps(item, reservationId);
  const openResult = await setSpaceCloudExternalReservation(item, mode, reservationId, {
    allowStillBlockedAfterDelete: overlaps.length > 0,
    claimUnlabelledBeforeDelete: options.claimUnlabelledBeforeDelete,
  });
  if (!openResult.ok) return openResult;
  if (overlaps.length === 0) return openResult;

  const repairFailures: string[] = [];
  for (const overlap of overlaps) {
    const overlapItem = normalizeReservationForSlotRecheck(overlap);
    const repairResult = await setSpaceCloudExternalReservation(overlapItem, "close", overlap.id);
    if (!repairResult.ok) {
      repairFailures.push(`${overlap.customerName || overlap.id}: ${repairResult.reason || "Unknown failure"}`);
    }
  }

  if (repairFailures.length > 0) {
    return {
      ok: false,
      skipped: false,
      reason: `SpaceCloud overlap repair failed after open: ${repairFailures.join(" / ")}`,
    };
  }

  return openResult;
}

async function runSlotItemBatch(
  items: NormalizedNaverReservation[],
  action: (item: NormalizedNaverReservation) => Promise<SlotActionResult>,
  label: string,
): Promise<SlotActionResult> {
  if (items.length === 0) {
    return { ok: true, skipped: true, reason: `${label} skipped because active overlapping reservation keeps slot closed.` };
  }

  const failures: string[] = [];
  let skipped = true;

  for (const item of items) {
    const result = await action(item);
    skipped = skipped && result.skipped;
    if (!result.ok) failures.push(result.reason || "Unknown failure");
  }

  if (failures.length > 0) {
    return { ok: false, skipped, reason: failures.join(" / ") };
  }

  return { ok: true, skipped, reason: null };
}

function settledSlotResult(result: PromiseSettledResult<SlotActionResult>) {
  if (result.status === "fulfilled") return result.value;
  const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return { ok: false, skipped: false, reason };
}

async function syncNaverAndSpaceCloudSlots(
  item: NormalizedNaverReservation,
  mode: "close" | "open",
  reservationId: string,
  bookingLabel: string,
  options: { claimUnlabelledBeforeDelete?: boolean } = {},
) {
  console.log(`[NaverRPA] Start parallel slot ${mode}: ${bookingLabel}`);
  const naverItems = await buildNaverSlotItems(item, mode, reservationId);
  const spaceCloudItems = [item];

  const [naverResult, spaceCloudResult] = await Promise.allSettled([
    runSlotItemBatch(naverItems, (slotItem) => setNaverSlot(slotItem, mode), "Naver slot"),
    runSlotItemBatch(
      spaceCloudItems,
      (slotItem) => runSpaceCloudSlotAction(slotItem, mode, reservationId, options),
      "SpaceCloud external reservation",
    ),
  ]);

  const naverSlot = settledSlotResult(naverResult);
  const spaceCloudSlot = settledSlotResult(spaceCloudResult);

  if (naverSlot.ok) {
    await clearRpaCheckRequired(reservationId, isNaverSlotCheckLine);
  } else {
    await markRpaCheckRequired(reservationId, `Naver slot ${mode} failed: ${naverSlot.reason}`);
  }

  if (spaceCloudSlot.ok) {
    await clearRpaCheckRequired(reservationId, isSpaceCloudExternalCheckLine);
  } else {
    await markRpaCheckRequired(
      reservationId,
      `SpaceCloud external reservation ${mode} failed: ${spaceCloudSlot.reason}`,
    );
  }

  console.log(`[NaverRPA] Slot ${mode} result for ${bookingLabel}: ${naverSlot.ok ? "ok" : naverSlot.reason}`);
  console.log(
    `[NaverRPA] SpaceCloud external ${mode} result for ${bookingLabel}: ${spaceCloudSlot.ok ? "ok" : spaceCloudSlot.reason}`,
  );

  return { naverSlot, spaceCloudSlot };
}

export async function recheckNaverSlotRpaIssues(limit = 1) {
  const cooldownMs = 10 * 60 * 1000;
  const now = Date.now();
  const attemptedAt = getRpaRecheckMap();
  const candidates = await prisma.reservation.findMany({
    where: {
      memo: { contains: RPA_CHECK_MARKER },
      roomName: { in: ["머무룸1", "머무룸2", "머무룸3"] },
      endTime: { gte: new Date(now - 24 * 60 * 60 * 1000) },
    },
    include: { usageLog: true },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });

  let checked = 0;
  let resolved = 0;

  for (const reservation of candidates) {
    if (checked >= limit) break;
    if (!isSlotRpaIssueMemo(reservation.memo)) continue;

    const lastAttempt = attemptedAt.get(reservation.id) || 0;
    if (now - lastAttempt < cooldownMs) continue;
    attemptedAt.set(reservation.id, now);

    const bookingNumber = reservation.source === "naver"
      ? naverBookingNumberFromEmailId(reservation.emailId)
      : null;
    if (bookingNumber) {
      try {
        const detail = await readNaverDetail(bookingNumber, toKstDateValue(reservation.startTime));
        if (detail.bookingStatus?.includes("\uCDE8\uC18C")) {
          const detailItem = normalizeDetail(detail);
          detailItem.status = "CANCELLED";
          detailItem.price = parseCancellationFeeFromDetail(detail);
          detailItem.isPaid = detailItem.price > 0;

          const result = await cancelNaverReservation(
            detailItem,
            reservation.emailId || `naver:${bookingNumber}`,
            detailItem.price,
            reservation.createdAt,
          );
          await clearRpaCheckRequired(result.reservation.id, isObsoleteCloseCheckLine);
          await syncNaverAndSpaceCloudSlots(
            normalizeReservationForSlotRecheck(result.reservation),
            "open",
            result.reservation.id,
            bookingNumber,
          );

          checked += 1;
          const after = await prisma.reservation.findUnique({
            where: { id: result.reservation.id },
            select: { memo: true },
          });
          if (!after?.memo?.includes(RPA_CHECK_MARKER)) resolved += 1;
          continue;
        }
      } catch (error) {
        console.log(
          `[NaverRPA] Could not refresh Naver detail during slot recheck: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    const item = normalizeReservationForSlotRecheck(reservation);
    const mode = reservation.status === "CANCELLED" && !reservation.isNoShow ? "open" : "close";
    console.log(`[NaverRPA] Recheck slot issue: ${reservation.id} ${item.dateValue} ${item.startClock}-${item.endClock} mode=${mode}`);

    const hasNaverIssue = hasCheckLine(reservation.memo, isNaverSlotCheckLine);
    const hasSpaceCloudIssue = hasCheckLine(reservation.memo, isSpaceCloudExternalCheckLine);
    const beforeMemo = reservation.memo;

    if (hasNaverIssue) {
      await setNaverSlot(item, mode, reservation.id);
    }

    if (hasSpaceCloudIssue) {
      await runSpaceCloudSlotAction(item, mode, reservation.id);
    }

    checked += 1;

    const after = await prisma.reservation.findUnique({
      where: { id: reservation.id },
      select: { memo: true },
    });
    if (beforeMemo !== after?.memo && !after?.memo?.includes(RPA_CHECK_MARKER)) {
      resolved += 1;
    }
  }

  return { checked, resolved };
}

export async function reconcileNaverReservationsWithoutCancelEmail(limit = 1) {
  const now = Date.now();
  const checkedAt = getNaverStatusCheckMap();
  const candidates = await prisma.reservation.findMany({
    where: {
      source: "naver",
      status: "CONFIRMED",
      isNoShow: false,
      emailId: { startsWith: "naver:" },
      startTime: {
        gte: new Date(now - 24 * 60 * 60 * 1000),
        lte: new Date(now + 120 * 24 * 60 * 60 * 1000),
      },
    },
    include: { usageLog: true },
    orderBy: [
      { updatedAt: "asc" },
      { startTime: "asc" },
    ],
    take: 20,
  });

  let checked = 0;
  let cancelled = 0;

  for (const reservation of candidates) {
    if (checked >= limit) break;

    const bookingNumber = naverBookingNumberFromEmailId(reservation.emailId);
    if (!bookingNumber) continue;

    const lastCheckedAt = checkedAt.get(reservation.id) || 0;
    const cooldownMs = naverStatusCheckCooldownMs();
    if (now - lastCheckedAt < cooldownMs) continue;
    checkedAt.set(reservation.id, now);

    try {
      const detail = await readNaverDetail(bookingNumber, toKstDateValue(reservation.startTime));
      checked += 1;

      if (!detail.bookingStatus?.includes("\uCDE8\uC18C")) {
        continue;
      }

      detail.bookingNumber ||= bookingNumber;
      const detailItem = normalizeDetail(detail, reservation.discount);
      detailItem.status = "CANCELLED";
      detailItem.price = parseCancellationFeeFromDetail(detail);
      detailItem.isPaid = detailItem.price > 0;

      const result = await cancelNaverReservation(
        detailItem,
        reservation.emailId || `naver:${bookingNumber}`,
        detailItem.price,
        reservation.createdAt,
      );

      await clearRpaCheckRequired(result.reservation.id, isObsoleteCloseCheckLine);
      await syncNaverAndSpaceCloudSlots(
        normalizeReservationForSlotRecheck(result.reservation),
        "open",
        result.reservation.id,
        bookingNumber,
      );

      cancelled += 1;
      console.log(`[NaverRPA] Cancelled reservation reconciled without cancel email: ${bookingNumber}`);
    } catch (error) {
      console.log(
        `[NaverRPA] Naver status reconcile failed for ${bookingNumber}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return { checked, cancelled };
}

export async function processNaverEmailWithRpa({
  messageId,
  subject,
  text,
  html,
  parsedReservation,
  receivedAt,
  supersededConfirmationJobs,
}: {
  messageId: string;
  subject: string;
  text: string;
  html?: string | false;
  parsedReservation: ParsedReservation;
  receivedAt?: Date;
  supersededConfirmationJobs?: unknown[];
}) {
  const bookingId = extractBookingId(subject, text, html);
  if (!bookingId && !parsedReservation.isCancelled) {
    throw new Error(`Could not find Naver booking id in email: ${subject}`);
  }

  if (parsedReservation.isCancelled) {
    let normalized = normalizeParsedReservation(parsedReservation, bookingId);

    if (bookingId) {
      try {
        console.log(`[NaverRPA] Read cancelled detail for booking ${bookingId}`);
        const detail = await readNaverDetail(bookingId, toKstDateValue(parsedReservation.startTime));
        detail.bookingNumber ||= bookingId;
        normalized = normalizeDetail(detail);
      } catch (error) {
        console.log(
          `[NaverRPA] Could not read cancelled detail. Use email fallback: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    normalized.status = "CANCELLED";
    normalized.price = parsedReservation.refundFee ?? 0;

    const result = await cancelNaverReservation(normalized, messageId, parsedReservation.refundFee ?? 0, receivedAt);
    const needsSlotOpenRetry = hasCheckLine(result.reservation.memo, isNaverSlotCheckLine)
      || hasCheckLine(result.reservation.memo, isSpaceCloudExternalCheckLine);
    if (result.changed || needsSlotOpenRetry) {
      await clearRpaCheckRequired(result.reservation.id, isObsoleteCloseCheckLine);
      await syncNaverAndSpaceCloudSlots(
        normalizeReservationForSlotRecheck(result.reservation),
        "open",
        result.reservation.id,
        bookingId || normalized.bookingNumber,
        {
          claimUnlabelledBeforeDelete: Boolean(supersededConfirmationJobs?.length),
        },
      );
    } else {
      console.log(`[NaverRPA] Reservation already cancelled. Skip slot open: ${result.reservation.id}`);
    }

    return { changed: result.changed, skipped: !result.changed, created: result.created, reservationId: result.reservation.id };
  }

  const existingReservation = await findExistingReservationByParsedEmail(parsedReservation);
  if (existingReservation && !existingReservation.memo?.includes(RPA_PENDING_MARKER)) {
    console.log(`[NaverRPA] Reservation already exists. Skip RPA: ${existingReservation.id}`);
    return { changed: false, skipped: true, reservationId: existingReservation.id };
  }

  console.log(`[NaverRPA] Read detail for booking ${bookingId}`);
  const detail = await readNaverDetail(bookingId!, toKstDateValue(parsedReservation.startTime));
  detail.bookingNumber ||= bookingId;
  const normalized = normalizeDetail(detail, parsedReservation.discount ?? 0);
  const result = await upsertNaverReservation(normalized, messageId, receivedAt);

  if (normalized.status === "CONFIRMED") {
    await syncNaverAndSpaceCloudSlots(
      normalizeReservationForSlotRecheck(result.reservation),
      "close",
      result.reservation.id,
      bookingId!,
    );
  }

  return { changed: true, skipped: false, created: result.created, reservationId: result.reservation.id };
}
