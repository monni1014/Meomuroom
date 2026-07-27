import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { getKstDateKey, getKstDateParts } from "@/lib/kst-time";
import { getSituationMessageTemplates } from "@/lib/situation-message-templates";
import { lookupReservationReminderDelivery, sendReservationSituationMessage } from "@/lib/solapi-sms";

const SITUATION_TYPE = "SITE_VISIT_GUIDE";
export const SITE_VISIT_MESSAGE_PREFIX = "situation:site-visit:";
const ATTEMPT_PREFIX = "attempt:";
const ALERT_PREFIX = "site-visit-notification:";
const RECOVERY_WAIT_MS = 2 * 60 * 1000;
const RECOVERY_FAIL_MS = 10 * 60 * 1000;
const SEND_AHEAD_MS = 2 * 60 * 60 * 1000;

export function siteVisitMessageDedupeKey(scheduleId: string) {
  return `${SITE_VISIT_MESSAGE_PREFIX}${scheduleId}`;
}

export function siteVisitScheduleIdFromDedupeKey(dedupeKey: string) {
  return dedupeKey.startsWith(SITE_VISIT_MESSAGE_PREFIX)
    ? dedupeKey.slice(SITE_VISIT_MESSAGE_PREFIX.length)
    : null;
}

function alertDedupeKey(scheduleId: string) {
  return `${ALERT_PREFIX}${scheduleId}`;
}

function formatScheduleLabel(schedule: {
  roomName: string;
  cleanerName: string;
  startTime: Date;
}) {
  const parts = getKstDateParts(schedule.startTime);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${schedule.roomName} / ${schedule.cleanerName} / ${getKstDateKey(schedule.startTime)} ${time}`;
}

async function recordFailure(
  schedule: { id: string; roomName: string; cleanerName: string; startTime: Date },
  error: string,
) {
  await createAdminAlert({
    type: "SITE_VISIT_NOTIFICATION_FAILED",
    severity: "CRITICAL",
    title: "사전답사 안내 문자 수신 실패",
    message: `${formatScheduleLabel(schedule)} / 사유: ${error}`,
    dedupeKey: alertDedupeKey(schedule.id),
  });
}

async function recoverInterruptedMessages(now: Date) {
  const interrupted = await prisma.customerMessage.findMany({
    where: {
      direction: "OUTBOUND",
      dedupeKey: { startsWith: SITE_VISIT_MESSAGE_PREFIX },
      status: "SENDING",
      updatedAt: { lt: new Date(now.getTime() - RECOVERY_WAIT_MS) },
    },
  });

  let recoveredCount = 0;
  let recoveryWaitingCount = 0;
  for (const message of interrupted) {
    const scheduleId = siteVisitScheduleIdFromDedupeKey(message.dedupeKey);
    const schedule = scheduleId
      ? await prisma.cleaningSchedule.findUnique({ where: { id: scheduleId } })
      : null;
    const attemptId = message.providerMessageId?.startsWith(ATTEMPT_PREFIX)
      ? message.providerMessageId.slice(ATTEMPT_PREFIX.length)
      : null;

    if (!schedule || schedule.scheduleType !== "SITE_VISIT" || !attemptId) {
      if (now.getTime() - message.updatedAt.getTime() >= RECOVERY_FAIL_MS) {
        await prisma.customerMessage.update({
          where: { id: message.id },
          data: { status: "FAILED" },
        });
      } else {
        recoveryWaitingCount += 1;
      }
      continue;
    }

    try {
      const recovered = await lookupReservationReminderDelivery({
        reservationId: schedule.id,
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
          await recordFailure(schedule, recovered.error || "솔라피 발송 실패");
        } else {
          await resolveAdminAlertByDedupeKey(alertDedupeKey(schedule.id));
        }
        recoveredCount += 1;
        continue;
      }
    } catch (error) {
      console.error("Site visit message recovery lookup failed:", error);
    }

    if (now.getTime() - message.updatedAt.getTime() >= RECOVERY_FAIL_MS) {
      const error = "서버 중단 전후의 솔라피 발송 이력을 확인하지 못해 중복 방지를 위해 자동 재발송하지 않습니다.";
      await prisma.customerMessage.update({
        where: { id: message.id },
        data: { status: "FAILED" },
      });
      await recordFailure(schedule, error);
    } else {
      recoveryWaitingCount += 1;
    }
  }

  return { recoveredCount, recoveryWaitingCount };
}

export async function sendDueSiteVisitGuides(now = new Date()) {
  const pipelineStartedAt = Date.now();
  const recovery = await recoverInterruptedMessages(now);
  const template = (await getSituationMessageTemplates()).find((item) => item.key === SITUATION_TYPE);
  if (!template?.content.trim()) {
    return {
      success: true,
      checkedCount: 0,
      sentCount: 0,
      dryRunCount: 0,
      waitingContactCount: 0,
      failedCount: 0,
      ...recovery,
      pipelineMs: Date.now() - pipelineStartedAt,
      templateReady: false,
    };
  }

  const schedules = await prisma.cleaningSchedule.findMany({
    where: {
      scheduleType: "SITE_VISIT",
      startTime: {
        gte: now,
        lte: new Date(now.getTime() + SEND_AHEAD_MS),
      },
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    take: 100,
  });
  const dedupeKeys = schedules.map((schedule) => siteVisitMessageDedupeKey(schedule.id));
  const existingMessages = dedupeKeys.length > 0
    ? await prisma.customerMessage.findMany({
        where: { dedupeKey: { in: dedupeKeys } },
        select: { dedupeKey: true },
      })
    : [];
  const existingDedupeKeys = new Set(existingMessages.map((message) => message.dedupeKey));

  let sentCount = 0;
  let dryRunCount = 0;
  let waitingContactCount = 0;
  let failedCount = 0;

  for (const schedule of schedules) {
    const dedupeKey = siteVisitMessageDedupeKey(schedule.id);
    if (existingDedupeKeys.has(dedupeKey)) continue;

    const phone = normalizeKoreanPhone(schedule.contactPhone);
    if (!isValidKoreanMobilePhone(phone)) {
      waitingContactCount += 1;
      await recordFailure(schedule, "사전답사 연락처가 없거나 올바르지 않습니다.");
      continue;
    }

    const attemptId = randomUUID();
    try {
      await prisma.customerMessage.create({
        data: {
          direction: "OUTBOUND",
          channel: "LMS",
          status: "SENDING",
          senderNumber: "",
          recipientNumber: phone,
          customerPhone: phone,
          body: template.content,
          providerMessageId: `${ATTEMPT_PREFIX}${attemptId}`,
          dedupeKey,
          reservationId: null,
          occurredAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }

    const result = await sendReservationSituationMessage({
      reservationId: schedule.id,
      notificationAttemptId: attemptId,
      messageDedupeKey: dedupeKey,
      situationType: SITUATION_TYPE,
      phone: schedule.contactPhone,
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
      await resolveAdminAlertByDedupeKey(alertDedupeKey(schedule.id));
    } else {
      failedCount += 1;
      await recordFailure(schedule, result.error || "솔라피 발송 실패");
    }
  }

  return {
    success: failedCount === 0 && recovery.recoveryWaitingCount === 0,
    checkedCount: schedules.length,
    sentCount,
    dryRunCount,
    waitingContactCount,
    failedCount,
    ...recovery,
    pipelineMs: Date.now() - pipelineStartedAt,
    templateReady: true,
  };
}
