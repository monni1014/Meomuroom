import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { getKstDateKey, getKstDateParts } from "@/lib/kst-time";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { prisma } from "@/lib/prisma";
import { getSituationMessageTemplates } from "@/lib/situation-message-templates";
import { sendReservationSituationMessage } from "@/lib/solapi-sms";

const SITUATION_TYPE = "REVIEW_REFUND_ACCOUNT_REQUEST";
export const REVIEW_REFUND_ACCOUNT_MESSAGE_PREFIX = "situation:review-refund-account:";
const ATTEMPT_PREFIX = "attempt:";
const ALERT_PREFIX = "review-refund-account-notification:";

export function reviewRefundAccountMessageDedupeKey(reservationId: string) {
  return `${REVIEW_REFUND_ACCOUNT_MESSAGE_PREFIX}${reservationId}`;
}

export function reviewRefundAccountAlertDedupeKey(reservationId: string) {
  return `${ALERT_PREFIX}${reservationId}`;
}

export async function getReviewRefundAccountMessageReadiness(phone: string | null) {
  const normalizedPhone = normalizeKoreanPhone(phone);
  if (!isValidKoreanMobilePhone(normalizedPhone)) {
    return { ready: false as const, error: "예약의 고객 전화번호를 확인해 주세요." };
  }

  const template = (await getSituationMessageTemplates())
    .find((item) => item.key === SITUATION_TYPE);
  if (!template?.content.trim()) {
    return {
      ready: false as const,
      error: "설정 → 메시지에서 리뷰 환급 계좌 요청 문자 내용을 먼저 저장해 주세요.",
    };
  }

  return { ready: true as const, normalizedPhone, template };
}

function reservationLabel(reservation: {
  roomName: string;
  customerName: string | null;
  startTime: Date;
}) {
  const parts = getKstDateParts(reservation.startTime);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${reservation.roomName} / ${reservation.customerName || "이름 없음"} / ${getKstDateKey(reservation.startTime)} ${time}`;
}

export async function sendReviewRefundAccountRequest(reservationId: string, now = new Date()) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) {
    return { success: false, statusCode: 404, error: "예약을 찾을 수 없습니다." };
  }

  const readiness = await getReviewRefundAccountMessageReadiness(reservation.phone);
  if (!readiness.ready) {
    return { success: false, statusCode: 400, error: readiness.error };
  }

  const dedupeKey = reviewRefundAccountMessageDedupeKey(reservation.id);
  const existing = await prisma.customerMessage.findUnique({ where: { dedupeKey } });
  if (existing) {
    return existing.status === "FAILED"
      ? {
          success: false,
          statusCode: 409,
          alreadyProcessed: true,
          status: existing.status,
          error: "이 예약의 리뷰 계좌 요청 문자 발송이 이미 실패했습니다. 중복 발송 방지를 위해 자동 재발송하지 않습니다.",
        }
      : { success: true, statusCode: 200, alreadyProcessed: true, status: existing.status };
  }

  const attemptId = randomUUID();
  try {
    await prisma.customerMessage.create({
      data: {
        direction: "OUTBOUND",
        channel: "SMS",
        status: "SENDING",
        senderNumber: "",
        recipientNumber: readiness.normalizedPhone,
        customerPhone: readiness.normalizedPhone,
        body: readiness.template.content,
        providerMessageId: `${ATTEMPT_PREFIX}${attemptId}`,
        dedupeKey,
        reservationId: reservation.id,
        occurredAt: now,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: true, statusCode: 200, alreadyProcessed: true, status: "SENDING" };
    }
    throw error;
  }

  const result = await sendReservationSituationMessage({
    reservationId: reservation.id,
    notificationAttemptId: attemptId,
    messageDedupeKey: dedupeKey,
    situationType: SITUATION_TYPE,
    phone: reservation.phone,
    subject: readiness.template.subject,
    text: readiness.template.content,
  });
  const status = result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED";

  await prisma.customerMessage.update({
    where: { dedupeKey },
    data: {
      status,
      channel: result.channel,
      senderNumber: result.from,
      recipientNumber: result.to || readiness.normalizedPhone,
      customerPhone: result.to || readiness.normalizedPhone,
      body: result.text,
      providerMessageId: result.messageId || `${ATTEMPT_PREFIX}${attemptId}`,
    },
  });

  if (result.success) {
    await resolveAdminAlertByDedupeKey(reviewRefundAccountAlertDedupeKey(reservation.id));
  } else {
    await createAdminAlert({
      type: "REVIEW_REFUND_ACCOUNT_NOTIFICATION_FAILED",
      severity: "CRITICAL",
      title: "리뷰 계좌 요청 문자 수신 실패",
      message: `${reservationLabel(reservation)} / 사유: ${result.error || "솔라피 발송 실패"}`,
      dedupeKey: reviewRefundAccountAlertDedupeKey(reservation.id),
    });
  }

  return {
    success: result.success,
    statusCode: result.success ? 200 : 502,
    status,
    dryRun: result.dryRun,
    error: result.error,
  };
}
