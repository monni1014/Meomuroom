import { prisma } from "@/lib/prisma";
import { sendPushNotification } from "@/lib/push-notifications";
import { buildSpaceCloudBookingPush } from "@/lib/spacecloud-booking-push-policy";

const RECORD_PREFIX = "push.spacecloudBooking.";
const SENDING_RETRY_MS = 2 * 60 * 1000;

type PushRecord = {
  status: "SENDING" | "SENT" | "FAILED";
  attemptedAt: string;
  sentAt?: string;
  sent?: number;
  failed?: number;
};

function recordKey(reservationId: string) {
  return `${RECORD_PREFIX}${reservationId}`;
}

function parseRecord(value: string): PushRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<PushRecord>;
    return parsed.status && parsed.attemptedAt ? parsed as PushRecord : null;
  } catch {
    return null;
  }
}

async function claimPush(reservationId: string, now: Date) {
  const key = recordKey(reservationId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.appSetting.findUnique({ where: { key } });
    const record = existing ? parseRecord(existing.value) : null;
    if (record?.status === "SENT") return false;
    if (
      record?.status === "SENDING"
      && now.getTime() - new Date(record.attemptedAt).getTime() < SENDING_RETRY_MS
    ) return false;

    const next: PushRecord = { status: "SENDING", attemptedAt: now.toISOString() };
    await tx.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    return true;
  });
}

export async function sendSpaceCloudBookingPush(reservationId: string, now = new Date()) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      source: true,
      status: true,
      isNoShow: true,
      roomName: true,
      customerName: true,
      startTime: true,
      endTime: true,
    },
  });
  if (!reservation || reservation.source !== "spacecloud" || reservation.status !== "CONFIRMED" || reservation.isNoShow) {
    return { skipped: true, reason: "not-a-confirmed-spacecloud-booking", sent: 0, failed: 0 };
  }
  if (!await claimPush(reservation.id, now)) {
    return { skipped: true, reason: "already-sent-or-in-progress", sent: 0, failed: 0 };
  }

  const payload = buildSpaceCloudBookingPush({
    reservationId: reservation.id,
    roomName: reservation.roomName,
    customerName: reservation.customerName,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
  });
  let result: Awaited<ReturnType<typeof sendPushNotification>>;
  try {
    result = await sendPushNotification(payload, { excludeAppleWebPush: true });
  } catch (error) {
    result = { configured: true, sent: 0, failed: 1 };
    console.error("[SpaceCloudPush] Delivery failed:", error);
  }

  const delivered = result.sent > 0;
  const record: PushRecord = {
    status: delivered ? "SENT" : "FAILED",
    attemptedAt: now.toISOString(),
    ...(delivered ? { sentAt: new Date().toISOString() } : {}),
    sent: result.sent,
    failed: result.failed,
  };
  await prisma.appSetting.update({
    where: { key: recordKey(reservation.id) },
    data: { value: JSON.stringify(record) },
  });

  return {
    skipped: false,
    reason: delivered ? null : "no-non-apple-push-delivery",
    sent: result.sent,
    failed: result.failed,
  };
}
