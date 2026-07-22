import MessagesView from "./MessagesView";
import { prisma } from "@/lib/prisma";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { getKstDayRange } from "@/lib/kst-time";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const now = new Date();
  const today = getKstDayRange(now);
  const tomorrowStart = new Date(today.end.getTime() + 1);
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const plannedReservationStart = new Date(today.start.getTime() + twoHoursMs);
  const plannedReservationEnd = new Date(tomorrowStart.getTime() + twoHoursMs);
  const twoHoursLater = new Date(now.getTime() + twoHoursMs);

  const reservations = await prisma.reservation.findMany({
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
        where: { direction: "OUTBOUND" },
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
  });

  const entries = reservations.map((reservation) => {
    const message = reservation.messages[0] || null;
    const scheduledAt = new Date(reservation.startTime.getTime() - 2 * 60 * 60 * 1000);
    const phone = normalizeKoreanPhone(reservation.phone);
    let status = message?.status || reservation.notificationStatus || "PENDING";
    if (status === "SENT") status = "SUBMITTED";
    if (!message && !isValidKoreanMobilePhone(phone)) status = "MISSING_PHONE";
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
      error: reservation.notificationError,
      sentAt: message?.occurredAt.toISOString() || reservation.notifiedAt?.toISOString() || null,
      resultAt: message?.updatedAt.toISOString() || reservation.notifiedAt?.toISOString() || null,
      providerMessageId: message?.providerMessageId || null,
      isTest: message?.dedupeKey.startsWith("reservation-test:") || false,
    };
  });

  return <MessagesView initialEntries={entries} todayLabel={`${today.parts.month}월 ${today.parts.day}일`} />;
}
