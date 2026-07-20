import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { sendReservationReminder } from "@/lib/solapi-sms";
import { recordOutboundReservationMessage } from "@/lib/customer-messages";

const ALERT_TYPE = "NOTIFICATION_DELIVERY";

function notificationAlertKey(reservationId: string) {
  return `notification-delivery:${reservationId}`;
}

function phoneLast4(phone: string | null) {
  return phone?.replace(/\D/g, "").slice(-4) || null;
}

function formatKstDateTime(startTime: Date, endTime: Date) {
  const date = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(startTime);
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time.format(startTime)}-${time.format(endTime)}`;
}

export async function sendDueReservationReminders() {
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const upcomingReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: now,
        lte: twoHoursLater,
      },
      notified: false,
      status: "CONFIRMED",
      isNoShow: false,
    },
    orderBy: { startTime: "asc" },
  });

  const results = [];
  let sentCount = 0;
  let dryRunCount = 0;
  let failedCount = 0;

  for (const reservation of upcomingReservations) {
    const result = await sendReservationReminder({
      reservationId: reservation.id,
      customerName: reservation.customerName,
      phone: reservation.phone,
      roomName: reservation.roomName,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
    });

    if (result.to && result.text) {
      await recordOutboundReservationMessage({
        reservationId: reservation.id,
        senderNumber: result.from,
        recipientNumber: result.to,
        body: result.text,
        channel: result.channel,
        status: result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED",
        providerMessageId: result.messageId,
      });
    }

    results.push({
      reservationId: reservation.id,
      customerName: reservation.customerName,
      roomName: reservation.roomName,
      startTime: reservation.startTime,
      phoneLast4: phoneLast4(reservation.phone),
      success: result.success,
      dryRun: result.dryRun,
      channel: result.channel,
      error: result.error,
    });

    if (result.success && result.dryRun) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          notificationStatus: "DRY_RUN",
          notificationChannel: result.channel,
          notificationError: null,
        },
      });
      dryRunCount += 1;
      continue;
    }

    if (result.success) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          notified: true,
          notifiedAt: new Date(),
          notificationStatus: "SUBMITTED",
          notificationChannel: result.channel,
          notificationError: null,
        },
      });
      await resolveAdminAlertByDedupeKey(notificationAlertKey(reservation.id));
      sentCount += 1;
      continue;
    }

    const errorMessage = result.error || "Unknown notification delivery failure.";
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        notificationStatus: "FAILED",
        notificationChannel: result.channel,
        notificationError: errorMessage,
      },
    });
    await createAdminAlert({
      type: ALERT_TYPE,
      severity: "CRITICAL",
      title: "예약 안내 문자 발송 실패",
      message: `${reservation.customerName || "이름 없음"} / ${reservation.roomName} / ${formatKstDateTime(reservation.startTime, reservation.endTime)} / 전화 끝자리 ${phoneLast4(reservation.phone) || "없음"} / ${errorMessage}`,
      dedupeKey: notificationAlertKey(reservation.id),
    });
    failedCount += 1;
  }

  return {
    success: failedCount === 0,
    checkedCount: upcomingReservations.length,
    sentCount,
    dryRunCount,
    failedCount,
    results,
  };
}
