import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { normalizeKoreanPhone } from "@/lib/phone-number";

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashSmsBridgeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function findReservationForCustomerPhone(phone: string, now = new Date()) {
  const normalizedPhone = normalizeKoreanPhone(phone);
  if (normalizedPhone.length < 9) return null;

  const last4 = normalizedPhone.slice(-4);
  const candidates = await prisma.reservation.findMany({
    where: {
      phone: { endsWith: last4 },
      startTime: {
        gte: new Date(now.getTime() - 730 * DAY_MS),
        lte: new Date(now.getTime() + 730 * DAY_MS),
      },
    },
  });
  const exactMatches = candidates.filter(
    (reservation) => normalizeKoreanPhone(reservation.phone) === normalizedPhone,
  );
  if (exactMatches.length === 0) return null;

  const confirmed = exactMatches.filter((reservation) => reservation.status === "CONFIRMED");
  const currentOrUpcoming = confirmed
    .filter((reservation) => reservation.endTime.getTime() >= now.getTime() - DAY_MS)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  if (currentOrUpcoming[0]) return currentOrUpcoming[0];

  const recentConfirmed = confirmed.sort(
    (a, b) => b.startTime.getTime() - a.startTime.getTime(),
  );
  if (recentConfirmed[0]) return recentConfirmed[0];

  return exactMatches.sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0];
}

type OutboundMessageInput = {
  reservationId: string;
  senderNumber: string;
  recipientNumber: string;
  body: string;
  channel: string;
  status: "SENDING" | "SUBMITTED" | "CARRIER_ACCEPTED" | "DELIVERED" | "FAILED" | "DRY_RUN";
  providerMessageId?: string | null;
  occurredAt?: Date;
};

function outboundMessageData(input: OutboundMessageInput, occurredAt: Date) {
  const customerPhone = normalizeKoreanPhone(input.recipientNumber);
  return {
    direction: "OUTBOUND",
    channel: input.channel,
    status: input.status,
    senderNumber: normalizeKoreanPhone(input.senderNumber),
    recipientNumber: customerPhone,
    customerPhone,
    body: input.body,
    providerMessageId: input.providerMessageId || null,
    reservationId: input.reservationId,
    occurredAt,
    readAt: occurredAt,
  };
}

export async function recordOutboundReservationMessage(input: OutboundMessageInput) {
  const occurredAt = input.occurredAt || new Date();
  const dedupeKey = `reservation-reminder:${input.reservationId}`;
  const messageData = outboundMessageData(input, occurredAt);

  return prisma.customerMessage.upsert({
    where: { dedupeKey },
    create: {
      ...messageData,
      dedupeKey,
    },
    update: {
      ...messageData,
    },
  });
}

type OutboundTestMessageInput = OutboundMessageInput & {
  notificationAttemptId: string;
};

export function reservationTestMessageDedupeKey(reservationId: string, notificationAttemptId: string) {
  return `reservation-test:${reservationId}:${notificationAttemptId}`;
}

export async function recordOutboundTestMessage(input: OutboundTestMessageInput) {
  const occurredAt = input.occurredAt || new Date();
  const dedupeKey = reservationTestMessageDedupeKey(input.reservationId, input.notificationAttemptId);
  const messageData = outboundMessageData(input, occurredAt);

  return prisma.customerMessage.upsert({
    where: { dedupeKey },
    create: {
      ...messageData,
      dedupeKey,
    },
    update: messageData,
  });
}

export async function finalizeOutboundTestMessage(input: OutboundTestMessageInput) {
  const dedupeKey = reservationTestMessageDedupeKey(input.reservationId, input.notificationAttemptId);
  const occurredAt = input.occurredAt || new Date();
  await prisma.customerMessage.updateMany({
    where: {
      dedupeKey,
      status: "SENDING",
    },
    data: outboundMessageData(input, occurredAt),
  });
  return prisma.customerMessage.findUniqueOrThrow({ where: { dedupeKey } });
}

export async function recordRecoveredReservationMessage(
  input: OutboundMessageInput & { notificationAttemptId: string },
) {
  const testDedupeKey = reservationTestMessageDedupeKey(
    input.reservationId,
    input.notificationAttemptId,
  );
  const testMessage = await prisma.customerMessage.findUnique({
    where: { dedupeKey: testDedupeKey },
    select: { id: true },
  });
  if (!testMessage) return recordOutboundReservationMessage(input);

  const occurredAt = input.occurredAt || new Date();
  return prisma.customerMessage.update({
    where: { id: testMessage.id },
    data: outboundMessageData(input, occurredAt),
  });
}
