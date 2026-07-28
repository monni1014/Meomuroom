import { prisma } from "@/lib/prisma";
import { after } from "next/server";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { mapSolapiDeliveryStatus, type SolapiDeliveryStatus } from "@/lib/solapi-delivery-status";
import { reservationTestMessageDedupeKey } from "@/lib/customer-messages";
import { buildReservationNotificationFailureAlert } from "@/lib/reservation-notification-failure-alert";
import { reviewRefundAccountAlertDedupeKey } from "@/lib/review-refund-account-notifications";
import { siteVisitScheduleIdFromDedupeKey } from "@/lib/site-visit-notifications";

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
  messageDedupeKey: string | null,
) {
  const exactClauses: Array<Record<string, string>> = [];
  if (report.messageId) exactClauses.push({ providerMessageId: report.messageId });
  if (report.groupId) exactClauses.push({ providerMessageId: report.groupId });
  if (messageDedupeKey) exactClauses.push({ dedupeKey: messageDedupeKey });
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
  const messageDedupeKey = typeof report.customFields?.messageDedupeKey === "string"
    ? report.customFields.messageDedupeKey
    : null;
  const message = await findMessage(report, reservationId, notificationAttemptId, messageDedupeKey);
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

    const isStandardReservationReminder = message.dedupeKey.startsWith("reservation-reminder:")
      || message.dedupeKey.startsWith("reservation-test:");
    if (message.reservationId && isStandardReservationReminder) {
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
  const siteVisitScheduleId = siteVisitScheduleIdFromDedupeKey(message.dedupeKey);
  if (!reservation && siteVisitScheduleId && statusChanged) {
    const schedule = await prisma.cleaningSchedule.findUnique({
      where: { id: siteVisitScheduleId },
      select: { id: true, roomName: true, cleanerName: true, startTime: true },
    });
    if (schedule) {
      const alertKey = `site-visit-notification:${schedule.id}`;
      if (status === "DELIVERED") {
        after(async () => {
          await resolveAdminAlertByDedupeKey(alertKey);
        });
      } else if (status === "FAILED") {
        const dateLabel = new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(schedule.startTime);
        after(async () => {
          await createAdminAlert({
            type: "SITE_VISIT_NOTIFICATION_FAILED",
            severity: "CRITICAL",
            title: "사전답사 안내 문자 수신 실패",
            message: `${schedule.roomName} / ${schedule.cleanerName} / ${dateLabel} / 사유: ${errorMessage}`,
            dedupeKey: alertKey,
          });
        });
      }
    }
    return { processed: true, status, reservationId: null, siteVisitScheduleId };
  }
  if (!reservation || !statusChanged) {
    return { processed: true, status, reservationId: message.reservationId };
  }

  const isDawnConfirmation = message.dedupeKey.startsWith("situation:dawn-booking:");
  const isOnTimeExit = message.dedupeKey.startsWith("situation:on-time-exit:");
  const isReviewRefundAccount = message.dedupeKey.startsWith("situation:review-refund-account:");
  const alertKey = isDawnConfirmation
    ? `dawn-booking-notification:${reservation.id}`
    : isOnTimeExit
      ? `on-time-exit-notification:${reservation.id}`
      : isReviewRefundAccount
        ? reviewRefundAccountAlertDedupeKey(reservation.id)
      : notificationAlertKey(reservation.id);

  if (status === "DELIVERED") {
    after(async () => {
      await resolveAdminAlertByDedupeKey(alertKey);
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
        type: isDawnConfirmation
          ? "DAWN_BOOKING_NOTIFICATION_FAILED"
          : isOnTimeExit
            ? "ON_TIME_EXIT_NOTIFICATION_FAILED"
            : isReviewRefundAccount
              ? "REVIEW_REFUND_ACCOUNT_NOTIFICATION_FAILED"
            : "NOTIFICATION_DELIVERY",
        severity: "CRITICAL",
        title: isDawnConfirmation
          ? "새벽 예약 확인 문자 수신 실패"
          : isOnTimeExit
            ? "정시퇴실 문자 수신 실패"
            : isReviewRefundAccount
              ? "리뷰 계좌 요청 문자 수신 실패"
            : failureAlert.title,
        message: failureAlert.message,
        dedupeKey: alertKey,
      });
    });
  }

  return { processed: true, status, reservationId: reservation.id };
}

export type { SolapiReport };
