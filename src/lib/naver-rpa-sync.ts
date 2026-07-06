import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma";
import type { ParsedReservation } from "./email-parser";
import { clearRpaPendingForReservation, RPA_PENDING_MARKER } from "./rpa-reservation-state";

const execFileAsync = promisify(execFile);

const ROOM_PRODUCT_URL: Record<string, string> = {
  "1": "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail",
  "2": "https://partner.booking.naver.com/bizes/1473933/biz-items/7007523/detail",
};

const RPA_CHECK_MARKER = "[RPA_CHECK_REQUIRED]";

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
};

type NormalizedNaverReservation = {
  bookingNumber: string;
  room: "1" | "2";
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

type RpaRecheckGlobal = typeof globalThis & {
  __naverSlotRpaIssueRecheckedAt?: Map<string, number>;
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

function parseAmount(value?: string | null) {
  if (!value) return 0;
  return Number(value.replace(/[^\d]/g, "")) || 0;
}

function parseHeadCount(value?: string | null) {
  if (!value) return 1;
  return Number(value.replace(/[^\d]/g, "")) || 1;
}

function parseRoom(productName?: string | null): "1" | "2" {
  if (productName?.includes("2")) return "2";
  return "1";
}

function parseRoomFromRoomName(roomName?: string | null): "1" | "2" {
  return roomName?.includes("2") ? "2" : "1";
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

  return {
    startTime: new Date(`${dateValue}T${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}:00+09:00`),
    endTime: new Date(`${dateValue}T${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}:00+09:00`),
  };
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

async function runNodeScript(args: string[], timeout = 180_000) {
  const result = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    timeout,
    maxBuffer: 1024 * 1024 * 5,
  });
  return result.stdout;
}

async function markRpaCheckRequired(reservationId: string, reason: string) {
  const clippedReason = reason.replace(/\s+/g, " ").trim().slice(0, 300);
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
    endClock: toClock(endTime),
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
    endClock: toClock(parsed.endTime),
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
    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        emailId: reservationEmailId,
        source: "naver",
        roomName: item.roomName,
        customerName: item.customerName,
        phone: item.phone,
        startTime: item.startTime,
        endTime: item.endTime,
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
    if (existing.status === "CANCELLED" && existing.price === cancellationPrice && !wasPending) {
      return { reservation: existing, created: false, changed: false };
    }

    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        emailId: reservationEmailId,
        source: "naver",
        roomName: item.roomName,
        customerName: isMaskedOrFallbackName(item.customerName) ? existing.customerName : item.customerName,
        phone: item.phone || existing.phone,
        startTime: item.startTime,
        endTime: item.endTime,
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

  return { reservation: created, created: true, changed: true };
}

function canSetSlot(item: NormalizedNaverReservation) {
  return item.startClock.endsWith(":00")
    && item.endClock.endsWith(":00")
    && item.endClock !== "00:00"
    && toKstDateValue(item.startTime) === toKstDateValue(item.endTime);
}

function isSlotRpaIssueMemo(memo?: string | null) {
  if (!memo?.includes(RPA_CHECK_MARKER)) return false;
  return [
    "naver-toggle-slots",
    "Naver slot",
    "Unsupported slot time",
    "Unsupported Naver slot time",
    "Could not navigate",
    "Could not find visual toggle",
    "Unsafe save blocked",
    "Command failed",
  ].some((pattern) => memo.includes(pattern));
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
    endClock: toClock(reservation.endTime),
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
    "spacecloud-external-reservation",
    "SpaceCloud login required",
    "SpaceCloud product",
    "SpaceCloud calendar",
  ].some((pattern) => line.includes(pattern));
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
    ], 240_000);

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
    if (item.customerName) args.push(`--customer-name=${item.customerName}`);
    if (item.phone) args.push(`--phone=${item.phone}`);

    await runNodeScript(args, 360_000);

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
) {
  console.log(`[NaverRPA] Start parallel slot ${mode}: ${bookingLabel}`);
  const [naverResult, spaceCloudResult] = await Promise.allSettled([
    setNaverSlot(item, mode),
    setSpaceCloudExternalReservation(item, mode),
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
      roomName: { in: ["머무룸1", "머무룸2"] },
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

    const item = normalizeReservationForSlotRecheck(reservation);
    const mode = reservation.status === "CANCELLED" && !reservation.isNoShow ? "open" : "close";
    console.log(`[NaverRPA] Recheck slot issue: ${reservation.id} ${item.dateValue} ${item.startClock}-${item.endClock} mode=${mode}`);

    const beforeMemo = reservation.memo;
    const slot = await setNaverSlot(item, mode, reservation.id);
    checked += 1;

    if (slot.ok) {
      const after = await prisma.reservation.findUnique({
        where: { id: reservation.id },
        select: { memo: true },
      });
      if (beforeMemo !== after?.memo && !after?.memo?.includes(RPA_CHECK_MARKER)) {
        resolved += 1;
      }
    }
  }

  return { checked, resolved };
}

export async function processNaverEmailWithRpa({
  messageId,
  subject,
  text,
  html,
  parsedReservation,
  receivedAt,
}: {
  messageId: string;
  subject: string;
  text: string;
  html?: string | false;
  parsedReservation: ParsedReservation;
  receivedAt?: Date;
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
    if (result.changed) {
      await syncNaverAndSpaceCloudSlots(
        normalized,
        "open",
        result.reservation.id,
        bookingId || normalized.bookingNumber,
      );
    } else {
      console.log(`[NaverRPA] Reservation already cancelled. Skip slot open: ${result.reservation.id}`);
    }

    return { changed: result.changed, skipped: !result.changed, created: result.created };
  }

  const existingReservation = await findExistingReservationByParsedEmail(parsedReservation);
  if (existingReservation && !existingReservation.memo?.includes(RPA_PENDING_MARKER)) {
    console.log(`[NaverRPA] Reservation already exists. Skip RPA: ${existingReservation.id}`);
    return { changed: false, skipped: true };
  }

  console.log(`[NaverRPA] Read detail for booking ${bookingId}`);
  const detail = await readNaverDetail(bookingId!, toKstDateValue(parsedReservation.startTime));
  detail.bookingNumber ||= bookingId;
  const normalized = normalizeDetail(detail, parsedReservation.discount ?? 0);
  const result = await upsertNaverReservation(normalized, messageId, receivedAt);

  if (normalized.status === "CONFIRMED") {
    await syncNaverAndSpaceCloudSlots(normalized, "close", result.reservation.id, bookingId!);
  }

  return { changed: true, skipped: false, created: result.created };
}
