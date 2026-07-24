import MessagesView from "./MessagesView";
import { prisma } from "@/lib/prisma";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { getKstDayRange } from "@/lib/kst-time";
import { getSolapiDailyUsage } from "@/lib/solapi-daily-usage";
import { buildReservationNotificationGroups } from "@/lib/reservation-notification-grouping";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const now = new Date();
  const today = getKstDayRange(now);
  const tomorrowStart = new Date(today.end.getTime() + 1);
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const plannedReservationStart = new Date(today.start.getTime() + twoHoursMs);
  const plannedReservationEnd = new Date(tomorrowStart.getTime() + twoHoursMs);
  const twoHoursLater = new Date(now.getTime() + twoHoursMs);

  const [reservations, dailyUsage] = await Promise.all([prisma.reservation.findMany({
    where: {
      status: "CONFIRMED",
      OR: [
        {
          startTime: {
            gte: plannedReservationStart,
            lt: plannedReservationEnd,
          },
        },
        {
          messages: {
            some: {
              direction: "OUTBOUND",
              occurredAt: { gte: today.start, lt: tomorrowStart },
              OR: [
                { dedupeKey: { startsWith: "reservation-reminder:" } },
                { dedupeKey: { startsWith: "reservation-test:" } },
              ],
            },
          },
        },
        {
          startTime: { gte: now, lte: twoHoursLater },
          notificationStatus: {
            in: ["PENDING", "SENDING", "RECOVERING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "FAILED"],
          },
        },
      ],
    },
    orderBy: { startTime: "asc" },
    include: {
      messages: {
        where: {
          direction: "OUTBOUND",
          OR: [
            { dedupeKey: { startsWith: "reservation-reminder:" } },
            { dedupeKey: { startsWith: "reservation-test:" } },
          ],
        },
        orderBy: { occurredAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          occurredAt: true,
          updatedAt: true,
          providerMessageId: true,
          dedupeKey: true,
        },
      },
    },
  }), getSolapiDailyUsage(today.start, tomorrowStart)]);

  const notificationGroups = buildReservationNotificationGroups(reservations);
  const groupLeaderByFollowerId = new Map<string, (typeof reservations)[number]>();
  for (const members of notificationGroups.values()) {
    const leader = members[0];
    if (!leader) continue;
    for (const follower of members.slice(1)) {
      groupLeaderByFollowerId.set(follower.id, leader);
    }
  }

  const entries = reservations.map((reservation) => {
    const message = reservation.messages[0] || null;
    const groupLeader = groupLeaderByFollowerId.get(reservation.id) || null;
    const scheduledAt = new Date(reservation.startTime.getTime() - 2 * 60 * 60 * 1000);
    const phone = normalizeKoreanPhone(reservation.phone);
    let status = message?.status || reservation.notificationStatus || "PENDING";
    let error = reservation.notificationError;
    if (status === "SENT") status = "SUBMITTED";
    if (!message && groupLeader) {
      status = "SKIPPED";
      error = "같은 날·같은 방·동일 고객은 첫 예약 시작 2시간 전에 안내문자를 한 번만 발송합니다.";
    } else if (!message && !isValidKoreanMobilePhone(phone)) status = "MISSING_PHONE";
    else if (!message && ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"].includes(status)) {
      if (scheduledAt.getTime() < now.getTime()) status = "OVERDUE";
      else if (status === "PENDING") status = "SCHEDULED";
    }

    return {
      reservationId: reservation.id,
      customerName: reservation.customerName,
      roomName: reservation.roomName,
      phone,
      startTime: reservation.startTime.toISOString(),
      endTime: reservation.endTime.toISOString(),
      scheduledAt: scheduledAt.toISOString(),
      reservationStatus: reservation.status,
      status,
      error,
      sentAt: message?.occurredAt.toISOString() || reservation.notifiedAt?.toISOString() || null,
      resultAt: message?.updatedAt.toISOString() || reservation.notifiedAt?.toISOString() || null,
      providerMessageId: message?.providerMessageId || null,
      isTest: message?.dedupeKey.startsWith("reservation-test:") || false,
    };
  });

  return (
    <MessagesView
      initialEntries={entries}
      todayLabel={`${today.parts.month}월 ${today.parts.day}일`}
      dailyUsage={dailyUsage}
    />
  );
}
