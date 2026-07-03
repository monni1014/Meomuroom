import type { ParsedReservation } from "./email-parser";
import { prisma } from "./prisma";

export const RPA_PENDING_MARKER = "[RPA_PENDING]";
export const RPA_CHECK_MARKER = "[RPA_CHECK_REQUIRED]";

function appendMemoLine(memo: string | null | undefined, line: string) {
  if (memo?.includes(line)) return memo;
  return [memo, line].filter(Boolean).join("\n");
}

function removeMarkedLines(memo: string | null | undefined, marker: string, shouldRemove: (line: string) => boolean = () => true) {
  if (!memo?.includes(marker)) return memo ?? null;

  const lines = memo
    .split(/\r?\n/)
    .filter((line) => !(line.includes(marker) && shouldRemove(line)))
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}

function pendingReason(source: string) {
  return `${RPA_PENDING_MARKER} ${source} detail/slot sync queued`;
}

function rpaCheckReason(reason: string) {
  const clipped = reason.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${RPA_CHECK_MARKER} ${clipped}`;
}

export function clearRpaPendingMemo(memo: string | null | undefined) {
  return removeMarkedLines(memo, RPA_PENDING_MARKER);
}

export async function clearRpaPendingForReservation(reservationId: string) {
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });

  if (!current?.memo?.includes(RPA_PENDING_MARKER)) return;

  const memo = clearRpaPendingMemo(current.memo);
  if (memo === current.memo) return;

  await prisma.reservation.update({
    where: { id: reservationId },
    data: { memo },
  });
}

async function findReservationForParsedEmail(parsed: ParsedReservation, messageId: string) {
  return prisma.reservation.findFirst({
    where: {
      OR: [
        { emailId: messageId },
        {
          source: parsed.source,
          roomName: parsed.roomName,
          startTime: parsed.startTime,
          endTime: parsed.endTime,
        },
      ],
    },
    include: { usageLog: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function ensureRpaPendingReservation(
  parsed: ParsedReservation,
  messageId: string,
  receivedAt?: Date,
) {
  const existing = await findReservationForParsedEmail(parsed, messageId);
  const status = parsed.isCancelled ? "CANCELLED" : "CONFIRMED";
  const price = parsed.isCancelled ? (parsed.refundFee ?? 0) : parsed.price;
  const memo = appendMemoLine(existing?.memo, pendingReason(parsed.source));

  if (existing) {
    return prisma.reservation.update({
      where: { id: existing.id },
      data: {
        status,
        price: parsed.isCancelled ? price : (existing.price > 0 ? existing.price : price),
        discount: parsed.discount ?? existing.discount,
        memo,
        isPaid: parsed.isCancelled ? price > 0 : existing.isPaid,
        usageLog: existing.usageLog
          ? { update: { reservedHeadCount: parsed.headCount } }
          : { create: { headCount: parsed.headCount, reservedHeadCount: parsed.headCount, purpose: null } },
      },
    });
  }

  return prisma.reservation.create({
    data: {
      emailId: messageId,
      source: parsed.source,
      roomName: parsed.roomName,
      customerName: parsed.customerName,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      createdAt: receivedAt || new Date(),
      price,
      discount: parsed.discount ?? 0,
      status,
      paymentMethod: "온라인",
      isPaid: parsed.isCancelled ? price > 0 : true,
      memo,
      usageLog: {
        create: {
          headCount: parsed.headCount,
          reservedHeadCount: parsed.headCount,
          purpose: null,
        },
      },
    },
  });
}

export async function markReservationRpaCheckRequired(reservationId: string, reason: string) {
  const current = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { memo: true },
  });

  if (!current) return;
  if (current.memo?.includes(RPA_CHECK_MARKER)) return;

  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      memo: appendMemoLine(current.memo, rpaCheckReason(reason)),
    },
  });
}

export async function markRpaJobCheckRequired(
  parsed: ParsedReservation,
  messageId: string,
  reason: string,
  receivedAt?: Date,
) {
  const reservation = await ensureRpaPendingReservation(parsed, messageId, receivedAt);
  await markReservationRpaCheckRequired(reservation.id, reason);
  return reservation;
}
