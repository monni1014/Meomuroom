import MessagesView from "./MessagesView";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { createKstDate, getKstDayRange } from "@/lib/kst-time";
import { getSolapiDailyUsage } from "@/lib/solapi-daily-usage";
import { buildReservationNotificationGroups } from "@/lib/reservation-notification-grouping";
import { customerMessageDisplay } from "@/lib/customer-message-display";

export const dynamic = "force-dynamic";

type MessagesSearchParams = Promise<{
  date?: string | string[];
}>;

function selectedKstDay(value: string | string[] | undefined, fallback: Date) {
  const dateKey = Array.isArray(value) ? value[0] : value;
  const match = dateKey?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return getKstDayRange(fallback);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = createKstDate(year, month, day);
  const range = getKstDayRange(parsed);
  return range.key === dateKey ? range : getKstDayRange(fallback);
}

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: MessagesSearchParams;
}) {
  const now = new Date();
  const currentDay = getKstDayRange(now);
  const query = await searchParams;
  const selectedDay = selectedKstDay(query.date, now);
  const isToday = selectedDay.key === currentDay.key;
  const nextDayStart = new Date(selectedDay.end.getTime() + 1);
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const plannedReservationStart = new Date(selectedDay.start.getTime() + twoHoursMs);
  const plannedReservationEnd = new Date(nextDayStart.getTime() + twoHoursMs);
  const twoHoursLater = new Date(now.getTime() + twoHoursMs);

  const reservationFilters: Prisma.ReservationWhereInput[] = [
    {
      status: "CONFIRMED",
      startTime: {
        gte: plannedReservationStart,
        lt: plannedReservationEnd,
      },
    },
    {
      messages: {
        some: {
          direction: "OUTBOUND",
          occurredAt: { gte: selectedDay.start, lt: nextDayStart },
          OR: [
            { dedupeKey: { startsWith: "reservation-reminder:" } },
            { dedupeKey: { startsWith: "reservation-test:" } },
          ],
        },
      },
    },
  ];

  if (isToday) {
    reservationFilters.push({
      status: "CONFIRMED",
      startTime: { gte: now, lte: twoHoursLater },
      notificationStatus: {
        in: ["PENDING", "SENDING", "RECOVERING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "FAILED"],
      },
    });
  }

  const [reservations, situationMessages, dailyUsage] = await Promise.all([prisma.reservation.findMany({
    where: {
      OR: reservationFilters,
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
          occurredAt: { gte: selectedDay.start, lt: nextDayStart },
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
  }), prisma.customerMessage.findMany({
    where: {
      direction: "OUTBOUND",
      dedupeKey: { startsWith: "situation:" },
      occurredAt: { gte: selectedDay.start, lt: nextDayStart },
    },
    include: { reservation: true },
    orderBy: { occurredAt: "desc" },
  }), getSolapiDailyUsage(selectedDay.start, nextDayStart)]);

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
      entryId: message?.id || `guide:${reservation.id}`,
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
      messageType: "GUIDE" as const,
      messageLabel: "이용 안내",
    };
  });

  const situationEntries = situationMessages.flatMap((message) => {
    const reservation = message.reservation;
    if (!reservation) return [];

    const display = customerMessageDisplay(message.dedupeKey);
    const status = message.status === "SENT" ? "SUBMITTED" : message.status;
    return [{
      entryId: message.id,
      reservationId: reservation.id,
      customerName: reservation.customerName,
      roomName: reservation.roomName,
      phone: normalizeKoreanPhone(reservation.phone),
      startTime: reservation.startTime.toISOString(),
      endTime: reservation.endTime.toISOString(),
      scheduledAt: message.occurredAt.toISOString(),
      reservationStatus: reservation.status,
      status,
      error: status === "FAILED" ? `${display.label} 문자 발송에 실패했습니다.` : null,
      sentAt: message.occurredAt.toISOString(),
      resultAt: message.updatedAt.toISOString(),
      providerMessageId: message.providerMessageId,
      isTest: false,
      messageType: display.type,
      messageLabel: display.label,
    }];
  });

  return (
    <MessagesView
      initialEntries={[...entries, ...situationEntries]}
      selectedDateKey={selectedDay.key}
      selectedDateLabel={`${selectedDay.parts.year}년 ${selectedDay.parts.month}월 ${selectedDay.parts.day}일`}
      isToday={isToday}
      dailyUsage={dailyUsage}
    />
  );
}
