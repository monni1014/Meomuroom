import { prisma } from "@/lib/prisma";
import { sendPushNotification } from "@/lib/push-notifications";
import {
  buildReservationEndReminderContent,
  RESERVATION_END_REMINDER_LEAD_MS,
} from "@/lib/reservation-end-reminder-policy";

const RETRY_STALE_MS = 20 * 1000;
const RECORD_PREFIX = "reservation.endReminder.";

type ReminderRecord = {
  status: "SENDING" | "SENT" | "FAILED";
  attemptedAt: string;
  sentAt?: string;
  sent?: number;
  failed?: number;
};

function reminderKey(reservationId: string, endTime: Date) {
  return `${RECORD_PREFIX}${reservationId}.${endTime.getTime()}`;
}

function parseRecord(value: string): ReminderRecord | null {
  try {
    const record = JSON.parse(value) as Partial<ReminderRecord>;
    if (!record.status || !record.attemptedAt) return null;
    return record as ReminderRecord;
  } catch {
    return null;
  }
}

async function claimReminder(key: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.appSetting.findUnique({ where: { key } });
    const record = existing ? parseRecord(existing.value) : null;
    if (record?.status === "SENT") return false;
    if (
      record?.status === "SENDING"
      && now.getTime() - new Date(record.attemptedAt).getTime() < RETRY_STALE_MS
    ) return false;

    const next: ReminderRecord = { status: "SENDING", attemptedAt: now.toISOString() };
    await tx.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    return true;
  });
}

function kstDateKey(date: Date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

export async function sendDueReservationEndReminders(now = new Date()) {
  const dueEnd = new Date(now.getTime() + RESERVATION_END_REMINDER_LEAD_MS);
  const reservations = await prisma.reservation.findMany({
    where: {
      status: "CONFIRMED",
      isNoShow: false,
      startTime: { lte: now },
      endTime: { gt: now, lte: dueEnd },
    },
    orderBy: [{ endTime: "asc" }, { id: "asc" }],
    include: {
      usageLog: {
        select: { reservedHeadCount: true, headCount: true },
      },
    },
  });

  // Split payments for the same stay must create only one owner reminder.
  const groups = new Map<string, typeof reservations>();
  for (const reservation of reservations) {
    const groupKey = [
      reservation.roomName,
      reservation.customerName?.trim() || "",
      reservation.endTime.getTime(),
    ].join("|");
    const group = groups.get(groupKey) || [];
    group.push(reservation);
    groups.set(groupKey, group);
  }

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const group of groups.values()) {
    const reservation = group[0];
    const key = reminderKey(reservation.id, reservation.endTime);
    if (!await claimReminder(key, now)) {
      skippedCount += 1;
      continue;
    }

    const headCount = Math.max(
      0,
      ...group.map((item) => (
        item.usageLog?.reservedHeadCount
        || item.usageLog?.headCount
        || 0
      )),
    );
    const content = buildReservationEndReminderContent({
      roomName: reservation.roomName,
      customerName: reservation.customerName,
      headCount,
    });
    const result = await sendPushNotification({
      ...content,
      url: `/calendar?date=${kstDateKey(reservation.startTime)}`,
      tag: `reservation-end-${reservation.id}-${reservation.endTime.getTime()}`,
    });
    const delivered = result.sent > 0;
    const completedAt = new Date();
    const record: ReminderRecord = {
      status: delivered ? "SENT" : "FAILED",
      attemptedAt: now.toISOString(),
      ...(delivered ? { sentAt: completedAt.toISOString() } : {}),
      sent: result.sent,
      failed: result.failed,
    };
    await prisma.appSetting.update({
      where: { key },
      data: { value: JSON.stringify(record) },
    });

    if (delivered) sentCount += 1;
    else failedCount += 1;
  }

  await prisma.appSetting.deleteMany({
    where: {
      key: { startsWith: RECORD_PREFIX },
      updatedAt: { lt: new Date(now.getTime() - 14 * 86_400_000) },
    },
  });

  return {
    checkedCount: reservations.length,
    groupCount: groups.size,
    sentCount,
    failedCount,
    skippedCount,
  };
}
