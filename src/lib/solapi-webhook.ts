import { prisma } from "@/lib/prisma";
import { after } from "next/server";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { mapSolapiDeliveryStatus, type SolapiDeliveryStatus } from "@/lib/solapi-delivery-status";
import { reservationTestMessageDedupeKey } from "@/lib/customer-messages";
import { buildReservationNotificationFailureAlert } from "@/lib/reservation-notification-failure-alert";

type SolapiReport = {
  messageId?: string;
  groupId?: string;
  type?: string;
  to?: string;
  from?: string;
  statusCode?: string;
  statusMessage?: string;
  dateProcessed?: string;
  dateReported?: string;
  customFields?: Record<string, unknown>;
};

function notificationAlertKey(reservationId: string) {
  return `notification-delivery:${reservationId}`;
}

async function findMessage(
  report: SolapiReport,
  reservationId: string | null,
  notificationAttemptId: string | null,
) {
  const exactClauses: Array<Record<string, string>> = [];
  if (report.messageId) exactClauses.push({ providerMessageId: report.messageId });
  if (report.groupId) exactClauses.push({ providerMessageId: report.groupId });
  if (reservationId && notificationAttemptId) {
    exactClauses.push({
      dedupeKey: reservationTestMessageDedupeKey(reservationId, notificationAttemptId),
    });
  }
  if (exactClauses.length === 0 && !reservationId) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const clause of exactClauses) {
      const message = await prisma.customerMessage.findFirst({
        where: { direction: "OUTBOUND", ...clause },
        include: { reservation: true },
      });
      if (message) return message;
    }
    if (attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return reservationId
    ? prisma.customerMessage.findFirst({
        where: { direction: "OUTBOUND", reservationId },
        orderBy: { occurredAt: "desc" },
        include: { reservation: true },
      })
    : null;
}

export async function processSolapiReport(report: SolapiReport) {
  const statusCode = String(report.statusCode || "").trim();
  if (!statusCode) return { processed: false, reason: "missing-status-code" };

  const reservationId = typeof report.customFields?.reservationId === "string"
    ? report.customFields.reservationId
    : null;
  const notificationAttemptId = typeof report.customFields?.notificationAttemptId === "string"
    ? report.customFields.notificationAttemptId
    : null;
  const message = await findMessage(report, reservationId, notificationAttemptId);
  if (!message) return { processed: false, reason: "message-not-found" };

  const status: SolapiDeliveryStatus = mapSolapiDeliveryStatus(statusCode);
  const statusChanged = message.status !== status;
  const errorMessage = status === "FAILED"
    ? `${report.statusMessage || "문자 수신 실패"} (${statusCode})`
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.customerMessage.update({
      where: { id: message.id },
      data: {
        status,
        ...(report.messageId ? { providerMessageId: report.messageId } : {}),
      },
    });

    if (message.reservationId) {
      await tx.reservation.update({
        where: { id: message.reservationId },
        data: {
          notified: true,
          notificationStatus: status,
          notificationChannel: report.type || message.channel,
          notificationError: errorMessage,
        },
      });
      await tx.appSetting.deleteMany({
        where: { key: `notification.sendAttempt.${message.reservationId}` },
      });
    }
  });

  const reservation = message.reservation;
  if (!reservation || !statusChanged) {
    return { processed: true, status, reservationId: message.reservationId };
  }

  if (status === "DELIVERED") {
    after(async () => {
      await resolveAdminAlertByDedupeKey(notificationAlertKey(reservation.id));
    });
  } else if (status === "FAILED") {
    const failureAlert = buildReservationNotificationFailureAlert({
      roomName: reservation.roomName,
      customerName: reservation.customerName,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      error: errorMessage,
    });
    after(async () => {
      await createAdminAlert({
        type: "NOTIFICATION_DELIVERY",
        severity: "CRITICAL",
        title: failureAlert.title,
        message: failureAlert.message,
        dedupeKey: notificationAlertKey(reservation.id),
      });
    });
  }

  return { processed: true, status, reservationId: reservation.id };
}

export type { SolapiReport };
