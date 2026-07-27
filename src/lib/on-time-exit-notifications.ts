import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { getKstDayRange, getKstDateKey, getKstDateParts } from "@/lib/kst-time";
import { resolveOnTimeExitTargets } from "@/lib/on-time-exit-policy";
import { getSituationMessageTemplates } from "@/lib/situation-message-templates";
import { lookupReservationReminderDelivery, sendReservationSituationMessage } from "@/lib/solapi-sms";

const SITUATION_TYPE = "ON_TIME_EXIT_REMINDER";
const MESSAGE_PREFIX = "situation:on-time-exit:";
const ATTEMPT_PREFIX = "attempt:";
const ALERT_PREFIX = "on-time-exit-notification:";
const RECOVERY_WAIT_MS = 2 * 60 * 1000;
const RECOVERY_FAIL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function messageDedupeKey(reservationId: string) {
  return `${MESSAGE_PREFIX}${reservationId}`;
}

function alertDedupeKey(reservationId: string) {
  return `${ALERT_PREFIX}${reservationId}`;
}

function formatReservationLabel(reservation: {
  roomName: string;
  customerName: string | null;
  startTime: Date;
}) {
  const parts = getKstDateParts(reservation.startTime);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${reservation.roomName} / ${reservation.customerName || "이름 없음"} / ${getKstDateKey(reservation.startTime)} ${time}`;
}

async function recordFailure(
  reservation: { id: string; roomName: string; customerName: string | null; startTime: Date },
  error: string,
) {
  await createAdminAlert({
    type: "ON_TIME_EXIT_NOTIFICATION_FAILED",
    severity: "CRITICAL",
    title: "정시퇴실 문자 수신 실패",
    message: `${formatReservationLabel(reservation)} / 사유: ${error}`,
    dedupeKey: alertDedupeKey(reservation.id),
  });
}

async function recoverInterruptedMessages(now: Date) {
  const interrupted = await prisma.customerMessage.findMany({
    where: {
      direction: "OUTBOUND",
      dedupeKey: { startsWith: MESSAGE_PREFIX },
      status: "SENDING",
      updatedAt: { lt: new Date(now.getTime() - RECOVERY_WAIT_MS) },
    },
    include: { reservation: true },
  });

  let recoveredCount = 0;
  let recoveryWaitingCount = 0;
  for (const message of interrupted) {
    const reservation = message.reservation;
    const attemptId = message.providerMessageId?.startsWith(ATTEMPT_PREFIX)
      ? message.providerMessageId.slice(ATTEMPT_PREFIX.length)
      : null;
    if (!reservation || !attemptId) {
      recoveryWaitingCount += 1;
      continue;
    }

    const recovered = await lookupReservationReminderDelivery({
      reservationId: reservation.id,
      notificationAttemptId: attemptId,
      phone: message.recipientNumber,
      now,
    });
    if (recovered.found) {
      await prisma.customerMessage.update({
        where: { id: message.id },
        data: {
          status: recovered.status,
          channel: recovered.channel,
          senderNumber: recovered.from,
          recipientNumber: recovered.to,
          customerPhone: recovered.to,
          body: recovered.text || message.body,
          providerMessageId: recovered.providerMessageId,
          occurredAt: recovered.occurredAt,
        },
      });
      if (recovered.status === "FAILED") {
        await recordFailure(reservation, recovered.error || "솔라피 발송 실패");
      } else {
        await resolveAdminAlertByDedupeKey(alertDedupeKey(reservation.id));
      }
      recoveredCount += 1;
      continue;
    }

    if (now.getTime() - message.updatedAt.getTime() >= RECOVERY_FAIL_MS) {
      const error = "서버 중단 이후 솔라피 발송 이력을 확인하지 못해 중복 방지를 위해 자동 재발송하지 않습니다.";
      await prisma.customerMessage.update({
        where: { id: message.id },
        data: { status: "FAILED" },
      });
      await recordFailure(reservation, error);
    } else {
      recoveryWaitingCount += 1;
    }
  }

  return { recoveredCount, recoveryWaitingCount };
}

export async function sendDueOnTimeExitMessages(now = new Date()) {
  const pipelineStartedAt = Date.now();
  const recovery = await recoverInterruptedMessages(now);
  const template = (await getSituationMessageTemplates()).find((item) => item.key === SITUATION_TYPE);

  return {
    success: recovery.recoveryWaitingCount === 0,
    checkedCount: 0,
    sentCount: 0,
    dryRunCount: 0,
    failedCount: 0,
    skippedCount: 0,
    templateReady: Boolean(template?.content.trim()),
    manualOnly: true,
    ...recovery,
    pipelineMs: Date.now() - pipelineStartedAt,
  };
}

export async function sendManualOnTimeExitMessage(reservationId: string, now = new Date()) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) {
    return { success: false, statusCode: 404, error: "예약을 찾을 수 없습니다." };
  }
  if (reservation.status !== "CONFIRMED" || reservation.isNoShow) {
    return { success: false, statusCode: 400, error: "취소 또는 노쇼 예약에는 정시퇴실 문자를 보낼 수 없습니다." };
  }

  const dayRange = getKstDayRange(reservation.startTime);
  const candidates = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: dayRange.start,
        lte: new Date(dayRange.end.getTime() + DAY_MS),
      },
      status: "CONFIRMED",
      isNoShow: false,
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
  const target = resolveOnTimeExitTargets(candidates)
    .find((item) => item.leader.id === reservation.id);
  if (!target) {
    return {
      success: false,
      statusCode: 409,
      error: "같은 공간에 다른 고객의 예약이 바로 이어지는 경우에만 발송할 수 있습니다.",
    };
  }

  const phone = normalizeKoreanPhone(reservation.phone);
  if (!isValidKoreanMobilePhone(phone)) {
    return { success: false, statusCode: 400, error: "예약의 고객 전화번호를 확인해 주세요." };
  }

  const template = (await getSituationMessageTemplates()).find((item) => item.key === SITUATION_TYPE);
  if (!template?.content.trim()) {
    return { success: false, statusCode: 400, error: "설정에서 정시퇴실 문자 내용을 먼저 저장해 주세요." };
  }

  const dedupeKey = messageDedupeKey(reservation.id);
  const existing = await prisma.customerMessage.findUnique({ where: { dedupeKey } });
  if (existing) {
    return existing.status === "FAILED"
      ? { success: false, statusCode: 409, alreadyProcessed: true, status: existing.status, error: "이 예약의 정시퇴실 문자 발송이 이미 실패했습니다. 중복 발송 방지를 위해 자동 재발송하지 않습니다." }
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
        recipientNumber: phone,
        customerPhone: phone,
        body: template.content,
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
    subject: template.subject,
    text: template.content,
  });
  const status = result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED";
  await prisma.customerMessage.update({
    where: { dedupeKey },
    data: {
      status,
      channel: result.channel,
      senderNumber: result.from,
      recipientNumber: result.to || phone,
      customerPhone: result.to || phone,
      body: result.text,
      providerMessageId: result.messageId || `${ATTEMPT_PREFIX}${attemptId}`,
    },
  });

  if (result.success) {
    await resolveAdminAlertByDedupeKey(alertDedupeKey(reservation.id));
  } else {
    await recordFailure(reservation, result.error || "솔라피 발송 실패");
  }

  return {
    success: result.success,
    statusCode: result.success ? 200 : 502,
    status,
    dryRun: result.dryRun,
    error: result.error,
  };
}
