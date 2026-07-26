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
const GUIDE_PREFIX = "reservation-reminder:";
const RECOVERY_WAIT_MS = 2 * 60 * 1000;
const RECOVERY_FAIL_MS = 10 * 60 * 1000;
const GUIDE_WINDOW_MS = 2 * 60 * 60 * 1000;
const GUIDE_SUCCESS_STATUSES = ["SUBMITTED", "CARRIER_ACCEPTED", "DELIVERED", "DRY_RUN"];

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

  if (!template?.content.trim()) {
    return {
      success: recovery.recoveryWaitingCount === 0,
      checkedCount: 0,
      sentCount: 0,
      dryRunCount: 0,
      failedCount: 0,
      skippedCount: 0,
      templateReady: false,
      ...recovery,
      pipelineMs: Date.now() - pipelineStartedAt,
    };
  }

  const upcoming = await prisma.reservation.findMany({
    where: {
      startTime: { gte: now, lte: new Date(now.getTime() + GUIDE_WINDOW_MS) },
      status: "CONFIRMED",
      isNoShow: false,
    },
    include: {
      messages: {
        where: {
          direction: "OUTBOUND",
          dedupeKey: { startsWith: GUIDE_PREFIX },
          status: { in: GUIDE_SUCCESS_STATUSES },
        },
        select: { id: true },
      },
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    take: 200,
  });
  const guidedReservationIds = new Set(
    upcoming.filter((reservation) => reservation.messages.length > 0).map((reservation) => reservation.id),
  );
  const dayRanges = upcoming.map((reservation) => getKstDayRange(reservation.startTime));
  const candidates = dayRanges.length > 0
    ? await prisma.reservation.findMany({
        where: {
          startTime: {
            gte: new Date(Math.min(...dayRanges.map((range) => range.start.getTime()))),
            lte: new Date(Math.max(...dayRanges.map((range) => range.end.getTime()))),
          },
          status: "CONFIRMED",
          isNoShow: false,
        },
        orderBy: [{ startTime: "asc" }, { id: "asc" }],
      })
    : [];
  const targets = resolveOnTimeExitTargets(candidates)
    .filter((target) => guidedReservationIds.has(target.leader.id));

  let sentCount = 0;
  let dryRunCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const target of targets) {
    const reservation = target.leader;
    const phone = normalizeKoreanPhone(reservation.phone);
    if (!isValidKoreanMobilePhone(phone)) {
      skippedCount += 1;
      continue;
    }

    const dedupeKey = messageDedupeKey(reservation.id);
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
        skippedCount += 1;
        continue;
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
    await prisma.customerMessage.update({
      where: { dedupeKey },
      data: {
        status: result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED",
        channel: result.channel,
        senderNumber: result.from,
        recipientNumber: result.to || phone,
        customerPhone: result.to || phone,
        body: result.text,
        providerMessageId: result.messageId || `${ATTEMPT_PREFIX}${attemptId}`,
      },
    });

    if (result.success && result.dryRun) {
      dryRunCount += 1;
    } else if (result.success) {
      sentCount += 1;
      await resolveAdminAlertByDedupeKey(alertDedupeKey(reservation.id));
    } else {
      failedCount += 1;
      await recordFailure(reservation, result.error || "솔라피 발송 실패");
    }
  }

  return {
    success: failedCount === 0 && recovery.recoveryWaitingCount === 0,
    checkedCount: targets.length,
    sentCount,
    dryRunCount,
    failedCount,
    skippedCount,
    templateReady: true,
    ...recovery,
    pipelineMs: Date.now() - pipelineStartedAt,
  };
}
