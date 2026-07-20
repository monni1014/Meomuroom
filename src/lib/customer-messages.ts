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
  status: "SUBMITTED" | "CARRIER_ACCEPTED" | "DELIVERED" | "FAILED" | "DRY_RUN";
  providerMessageId?: string | null;
  occurredAt?: Date;
};

export async function recordOutboundReservationMessage(input: OutboundMessageInput) {
  const customerPhone = normalizeKoreanPhone(input.recipientNumber);
  const occurredAt = input.occurredAt || new Date();
  const dedupeKey = `reservation-reminder:${input.reservationId}`;

  return prisma.customerMessage.upsert({
    where: { dedupeKey },
    create: {
      direction: "OUTBOUND",
      channel: input.channel,
      status: input.status,
      senderNumber: normalizeKoreanPhone(input.senderNumber),
      recipientNumber: customerPhone,
      customerPhone,
      body: input.body,
      providerMessageId: input.providerMessageId || null,
      dedupeKey,
      reservationId: input.reservationId,
      occurredAt,
      readAt: occurredAt,
    },
    update: {
      channel: input.channel,
      status: input.status,
      senderNumber: normalizeKoreanPhone(input.senderNumber),
      recipientNumber: customerPhone,
      customerPhone,
      body: input.body,
      providerMessageId: input.providerMessageId || null,
      occurredAt,
      readAt: occurredAt,
    },
  });
}
