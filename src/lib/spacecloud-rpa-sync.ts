import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma";
import type { ParsedReservation } from "./email-parser";
import { clearRpaPendingForReservation } from "./rpa-reservation-state";
import { reportRpaScriptFailure, resolveRpaScriptAlerts } from "./rpa-ui-alerts";

const execFileAsync = promisify(execFile);
const RPA_CHECK_MARKER = "[RPA_CHECK_REQUIRED]";

const FAST_NAVER_SLOT_RPA_ENV = {
  RPA_DELAY_MULTIPLIER: "0.5",
  RPA_MIN_RANDOM_DELAY_FLOOR_MS: "350",
  RPA_LOCK_RETRY_MIN_MS: "300",
  RPA_LOCK_RETRY_MAX_MS: "700",
};

const NAVER_ROOM_PRODUCT_URL: Record<string, string> = {
  "1": "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail",
  "2": "https://partner.booking.naver.com/bizes/1473933/biz-items/7007523/detail",
  "3": "https://partner.booking.naver.com/bizes/1473933/biz-items/7858758/detail",
};

type SpaceCloudDetailResult = {
  bookingStatus?: string | null;
  bookingNumber?: string | null;
  customerName?: string | null;
  phone?: string | null;
  productName?: string | null;
  useDateTime?: string | null;
  quantity?: string | null;
  priceText?: string | null;
  refundFee?: number | null;
  refundFeeFound?: boolean | null;
  refundFeeSource?: string | null;
  paymentAmount?: number | null;
  refundAmount?: number | null;
  screenshot?: string | null;
  currentUrl?: string | null;
};

function parseAmount(value?: string | null) {
  if (!value) return 0;
  return Number(value.replace(/[^\d]/g, "")) || 0;
}

function parseHeadCount(value?: string | null) {
  if (!value) return 1;
  return Number(value.replace(/[^\d]/g, "")) || 1;
}

function normalizePhone(value?: string | null) {
  if (!value) return null;
  return value.match(/0\d{1,2}-?\d{3,4}-?\d{4}/)?.[0] || null;
}

function pickCustomerName(parsed: ParsedReservation, detail?: SpaceCloudDetailResult | null) {
  const detailName = detail?.customerName?.trim();
  if (!detailName) return parsed.customerName;
  if (parsed.isCancelled && detailName.includes("*")) return parsed.customerName;
  return detailName;
}

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

function parseRoomNumber(roomName: string) {
  if (roomName === "머무룸3") return "3";
  if (roomName === "머무룸2") return "2";
  if (roomName === "머무룸1") return "1";
  throw new Error(`Unknown SpaceCloud reservation room: ${roomName || "(empty)"}`);
}

function normalizeUrl(url: string) {
  return url.replace(/&amp;/g, "&").trim();
}

function decodeSpaceCloudUrl(url: string) {
  let decoded = normalizeUrl(url);
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function extractSpaceCloudBookingNumberFromUrl(url?: string | null) {
  if (!url) return null;
  const decoded = decodeSpaceCloudUrl(url);
  return decoded.match(/\/reservation\/(\d+)\/?/i)?.[1] || null;
}

function isSpaceCloudReservationDetailUrl(url: string) {
  return Boolean(extractSpaceCloudBookingNumberFromUrl(url));
}

function buildSpaceCloudDetailUrl(bookingNumber: string) {
  return `https://partner.spacecloud.kr/reservation/${bookingNumber}/`;
}

function toSpaceCloudReservationEmailId(bookingNumber: string) {
  return `spacecloud:${bookingNumber}`;
}

function bookingNumberFromReservationEmailId(emailId?: string | null) {
  return emailId?.match(/^spacecloud:(\d+)$/)?.[1] || null;
}

function extractSpaceCloudDetailUrl(subject: string, text: string, html?: string | false) {
  const combined = `${subject}\n${text}\n${html || ""}`;
  const hrefMatches = [...combined.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => normalizeUrl(match[1]))
    .filter((url) => /spacecloud/i.test(url));

  const preferred = hrefMatches.find(isSpaceCloudReservationDetailUrl);
  if (preferred) return preferred;

  const rawMatches = combined.match(/https?:\/\/[^\s"'<>]*spacecloud[^\s"'<>]*/gi) || [];
  return rawMatches.map(normalizeUrl).find(isSpaceCloudReservationDetailUrl) || null;
}

function parseJsonFromStdout(stdout: string) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`SpaceCloud RPA did not return JSON. stdout=${stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as SpaceCloudDetailResult;
}

async function runNodeScript(args: string[], timeout = 180_000, envOverrides: Record<string, string> = {}) {
  const scriptPath = args[0] || "unknown-rpa-script";
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...envOverrides },
      timeout,
      maxBuffer: 1024 * 1024 * 5,
    });
    await resolveRpaScriptAlerts(scriptPath).catch((error) => {
      console.error(`[RPA alert] Could not resolve successful ${scriptPath}:`, error);
    });
    return result.stdout;
  } catch (error) {
    await reportRpaScriptFailure(error, scriptPath).catch((alertError) => {
      console.error(`[RPA alert] Could not report failed ${scriptPath}:`, alertError);
    });
    throw error;
  }
}

async function readSpaceCloudDetail(url: string) {
  return parseJsonFromStdout(await runNodeScript([
    "rpa/spacecloud-read-reservation-detail.mjs",
    `--url=${url}`,
  ]));
}

function canSetNaverSlot(item: ReturnType<typeof mergeDetail>) {
  const startClock = toClock(item.startTime);
  const endClock = toSlotEndClock(item.startTime, item.endTime);
  return startClock.endsWith(":00")
    && endClock.endsWith(":00")
    && (
      toKstDateValue(item.startTime) === toKstDateValue(item.endTime)
      || endClock === "24:00"
    );
}

async function setNaverSlotForSpaceCloud(item: ReturnType<typeof mergeDetail>, mode: "close" | "open", reservationId: string) {
  const room = parseRoomNumber(item.roomName);
  const dateValue = toKstDateValue(item.startTime);
  const startClock = toClock(item.startTime);
  const endClock = toSlotEndClock(item.startTime, item.endTime);

  if (!canSetNaverSlot(item)) {
    const reason = `Unsupported Naver slot time from SpaceCloud ${dateValue} ${startClock}-${endClock}`;
    await markRpaCheckRequired(reservationId, reason);
    return { ok: false, skipped: true, reason };
  }

  try {
    await runNodeScript([
      "rpa/naver-toggle-slots.mjs",
      `--room=${room}`,
      `--date=${dateValue}`,
      `--start=${startClock}`,
      `--end=${endClock}`,
      `--mode=${mode}`,
      `--product-url=${NAVER_ROOM_PRODUCT_URL[room]}`,
      "--apply",
    ], 240_000, FAST_NAVER_SLOT_RPA_ENV);

    await clearRpaCheckRequired(
      reservationId,
      (line) => line.includes("Naver slot") || line.includes("Unsupported Naver slot time"),
    );
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markRpaCheckRequired(reservationId, `Naver slot ${mode} failed for SpaceCloud reservation: ${reason}`);
    return { ok: false, skipped: false, reason };
  }
}

async function markRpaCheckRequired(reservationId: string, reason: string) {
  const clippedReason = reason.replace(/\s+/g, " ").trim().slice(0, 1200);
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });

  if (!current) return;
  if (current.memo?.includes(RPA_CHECK_MARKER)) return;

  const memo = [current.memo, `${RPA_CHECK_MARKER} SpaceCloud: ${clippedReason}`]
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

function mergeDetail(parsed: ParsedReservation, detail?: SpaceCloudDetailResult | null) {
  return {
    source: "spacecloud",
    roomName: parsed.roomName,
    customerName: pickCustomerName(parsed, detail),
    phone: normalizePhone(detail?.phone),
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    price: parsed.isCancelled ? (detail?.refundFee ?? parsed.refundFee ?? 0) : (parseAmount(detail?.priceText) || parsed.price),
    headCount: parseHeadCount(detail?.quantity) || parsed.headCount,
    status: parsed.isCancelled || detail?.bookingStatus?.includes("취소") ? "CANCELLED" : "CONFIRMED",
    refundFee: detail?.refundFee ?? parsed.refundFee ?? 0,
  } as const;
}

async function findExistingSpaceCloudReservation(parsed: ParsedReservation, bookingNumber?: string | null) {
  const emailIds = [
    parsed.emailId,
    bookingNumber ? toSpaceCloudReservationEmailId(bookingNumber) : null,
  ].filter((value): value is string => Boolean(value));

  return prisma.reservation.findFirst({
    where: {
      source: "spacecloud",
      roomName: parsed.roomName,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      OR: [
        ...emailIds.map((emailId) => ({ emailId })),
        { customerName: parsed.customerName },
      ],
    },
    include: { usageLog: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function processSpaceCloudEmailWithRpa({
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
  let detailUrl = extractSpaceCloudDetailUrl(subject, text, html);
  let bookingNumber = extractSpaceCloudBookingNumberFromUrl(detailUrl);
  let existing = await findExistingSpaceCloudReservation(parsedReservation, bookingNumber);

  if (!detailUrl && parsedReservation.isCancelled) {
    const existingBookingNumber = bookingNumberFromReservationEmailId(existing?.emailId);
    if (existingBookingNumber) {
      bookingNumber = existingBookingNumber;
      detailUrl = buildSpaceCloudDetailUrl(existingBookingNumber);
    }
  }

  let detail: SpaceCloudDetailResult | null = null;
  let rpaError: string | null = null;

  if (detailUrl) {
    try {
      console.log(`[SpaceCloudRPA] Read detail from host center: ${detailUrl}`);
      detail = await readSpaceCloudDetail(detailUrl);
      bookingNumber = detail.bookingNumber || bookingNumber || extractSpaceCloudBookingNumberFromUrl(detail.currentUrl);
    } catch (error) {
      rpaError = error instanceof Error ? error.message : String(error);
      console.log(`[SpaceCloudRPA] Detail read failed: ${rpaError}`);
    }
  } else {
    rpaError = "Could not find SpaceCloud host center URL in email.";
  }

  const item = mergeDetail(parsedReservation, detail);
  existing = existing || await findExistingSpaceCloudReservation(parsedReservation, bookingNumber);
  const reservationEmailId = bookingNumber
    ? toSpaceCloudReservationEmailId(bookingNumber)
    : existing?.emailId || messageId;

  if (existing) {
    const updated = await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        emailId: reservationEmailId,
        source: "spacecloud",
        roomName: item.roomName,
        customerName: item.customerName,
        phone: item.phone || existing.phone,
        startTime: item.startTime,
        endTime: item.endTime,
        price: item.status === "CANCELLED" ? item.refundFee : item.price,
        status: item.status,
        paymentMethod: "온라인",
        isPaid: item.status === "CANCELLED" ? item.refundFee > 0 : true,
        usageLog: existing.usageLog
          ? { update: { reservedHeadCount: item.headCount } }
          : { create: { headCount: item.headCount, reservedHeadCount: item.headCount, purpose: null } },
      },
      include: { usageLog: true },
    });

    const detailCheckReason = rpaError
      || (!(item.phone || existing.phone) && item.status === "CONFIRMED"
        ? "Phone number was not found in host center."
        : null)
      || (item.status === "CANCELLED" && (!detail || !detail.refundFeeFound)
        ? "Cancellation refund fee was not verified in host center."
        : null);

    if (detailCheckReason) {
      await markRpaCheckRequired(updated.id, detailCheckReason);
    }

    const slotMode = item.status === "CANCELLED" ? "open" : "close";
    const slot = await setNaverSlotForSpaceCloud(item, slotMode, updated.id);
    console.log(`[SpaceCloudRPA] Naver slot ${slotMode} result: ${slot.ok ? "ok" : slot.reason}`);
    if (slot.ok && !detailCheckReason) await clearRpaCheckRequired(updated.id);
    await clearRpaPendingForReservation(updated.id);

    return { changed: true, skipped: false, created: false, reservationId: updated.id };
  }

  const created = await prisma.reservation.create({
    data: {
      emailId: reservationEmailId,
      source: "spacecloud",
      roomName: item.roomName,
      customerName: item.customerName,
      phone: item.phone,
      startTime: item.startTime,
      endTime: item.endTime,
      createdAt: receivedAt || new Date(),
      price: item.status === "CANCELLED" ? item.refundFee : item.price,
      status: item.status,
      paymentMethod: "온라인",
      isPaid: item.status === "CANCELLED" ? item.refundFee > 0 : true,
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

  const detailCheckReason = rpaError
    || (!item.phone && item.status === "CONFIRMED"
      ? "Phone number was not found in host center."
      : null)
    || (item.status === "CANCELLED" && (!detail || !detail.refundFeeFound)
      ? "Cancellation refund fee was not verified in host center."
      : null);

  if (detailCheckReason) {
    await markRpaCheckRequired(created.id, detailCheckReason);
  }

  const slotMode = item.status === "CANCELLED" ? "open" : "close";
  const slot = await setNaverSlotForSpaceCloud(item, slotMode, created.id);
  console.log(`[SpaceCloudRPA] Naver slot ${slotMode} result: ${slot.ok ? "ok" : slot.reason}`);
  if (slot.ok && !detailCheckReason) await clearRpaCheckRequired(created.id);
  await clearRpaPendingForReservation(created.id);

  return { changed: true, skipped: false, created: true, reservationId: created.id };
}
