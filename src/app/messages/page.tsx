import MessagesView from "./MessagesView";
import { prisma } from "@/lib/prisma";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const now = new Date();
  const reservations = await prisma.reservation.findMany({
    where: {
      OR: [
        {
          status: "CONFIRMED",
          startTime: {
            gte: now,
            lte: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
          },
        },
        {
          messages: {
            some: {
              direction: "OUTBOUND",
              occurredAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
            },
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
          providerMessageId: true,
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
    if (!message && reservation.status === "CANCELLED") status = "CANCELLED";
    else if (!message && !isValidKoreanMobilePhone(phone)) status = "MISSING_PHONE";
    else if (!message && status === "PENDING") {
      status = scheduledAt.getTime() < now.getTime() ? "OVERDUE" : "SCHEDULED";
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
      providerMessageId: message?.providerMessageId || null,
    };
  });

  return <MessagesView initialEntries={entries} />;
}
