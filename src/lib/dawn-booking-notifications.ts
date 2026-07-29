import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { getKstDateKey, getKstDateParts } from "@/lib/kst-time";
import { RPA_PENDING_MARKER } from "@/lib/rpa-reservation-state";
import { getSituationMessageTemplates } from "@/lib/situation-message-templates";
import { lookupReservationReminderDelivery, sendReservationSituationMessage } from "@/lib/solapi-sms";
import { dawnBookingAutoSendStartsAt, isDawnBookingStart } from "@/lib/dawn-booking-policy";
import { buildReservationNotificationGroups } from "@/lib/reservation-notification-grouping";
import { syncReservationContactImmediately } from "@/lib/google-people";

const SITUATION_TYPE = "DAWN_BOOKING_CONFIRMATION";
const MESSAGE_PREFIX = "situation:dawn-booking:";
const ATTEMPT_PREFIX = "attempt:";
const ALERT_PREFIX = "dawn-booking-notification:";
const RECOVERY_WAIT_MS = 2 * 60 * 1000;
const RECOVERY_FAIL_MS = 10 * 60 * 1000;

function messageDedupeKey(reservationId: string) {
  return `${MESSAGE_PREFIX}${reservationId}`;
}

function alertDedupeKey(reservationId: string) {
  return `${ALERT_PREFIX}${reservationId}`;
}

function notificationReadyMemoWhere() {
  return {
    OR: [
      { memo: null },
      { NOT: { memo: { contains: RPA_PENDING_MARKER } } },
    ],
  };
}

function formatReservationLabel(reservation: {
  roomName: string;
  customerName: string | null;
  startTime: Date;
}) {
  const parts = getKstDateParts(reservation.startTime);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${reservation.roomName} / ${reservation.customerName || "이름 미확인"} / ${getKstDateKey(reservation.startTime)} ${time}`;
}

async function recordFailure(
  reservation: { id: string; roomName: string; customerName: string | null; startTime: Date },
  error: string,
) {
  await createAdminAlert({
    type: "DAWN_BOOKING_NOTIFICATION_FAILED",
    severity: "CRITICAL",
    title: "새벽 예약 확인 문자 수신 실패",
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
      const error = "서버 중단 전후의 솔라피 발송 이력을 확인하지 못해 중복 방지를 위해 자동 재발송하지 않습니다.";
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

async function createSkippedFollower(input: {
  reservationId: string;
  phone: string | null;
  body: string;
  now: Date;
}) {
  const phone = normalizeKoreanPhone(input.phone);
  try {
    await prisma.customerMessage.create({
      data: {
        direction: "OUTBOUND",
        channel: "LMS",
        status: "SKIPPED",
        senderNumber: "",
        recipientNumber: phone,
        customerPhone: phone,
        body: input.body,
        dedupeKey: messageDedupeKey(input.reservationId),
        reservationId: input.reservationId,
        occurredAt: input.now,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
}

export async function sendDueDawnBookingConfirmations(
  now = new Date(),
  options: { contactSyncAlreadyAttempted?: boolean } = {},
) {
  const pipelineStartedAt = Date.now();
  const startsAt = dawnBookingAutoSendStartsAt();
  if (!startsAt || now < startsAt) {
    return {
      success: true,
      checkedCount: 0,
      sentCount: 0,
      dryRunCount: 0,
      waitingContactCount: 0,
      contactSyncFailureCount: 0,
      contactSyncTimeoutCount: 0,
      failedCount: 0,
      skippedCount: 0,
      recoveredCount: 0,
      recoveryWaitingCount: 0,
      pipelineMs: Date.now() - pipelineStartedAt,
      deferredUntil: startsAt?.toISOString() || null,
    };
  }

  const recovery = await recoverInterruptedMessages(now);
  const template = (await getSituationMessageTemplates()).find((item) => item.key === SITUATION_TYPE);
  if (!template?.content.trim()) {
    return {
      success: false,
      checkedCount: 0,
      sentCount: 0,
      dryRunCount: 0,
      waitingContactCount: 0,
      contactSyncFailureCount: 0,
      contactSyncTimeoutCount: 0,
      failedCount: 1,
      skippedCount: 0,
      ...recovery,
      pipelineMs: Date.now() - pipelineStartedAt,
      deferredUntil: null,
      error: "새벽 시간 예약 확인 문자 본문이 비어 있습니다.",
    };
  }

  const reservations = (await prisma.reservation.findMany({
    where: {
      createdAt: { gte: startsAt },
      startTime: { gte: now },
      status: "CONFIRMED",
      isNoShow: false,
      ...notificationReadyMemoWhere(),
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    include: {
      messages: {
        where: { dedupeKey: { startsWith: MESSAGE_PREFIX } },
        select: { id: true },
      },
    },
    take: 200,
  })).filter((reservation) => isDawnBookingStart(reservation.startTime));

  const groups = buildReservationNotificationGroups(reservations);
  const groupLeaderIdByReservationId = new Map<string, string>();
  let sentCount = 0;
  let dryRunCount = 0;
  let waitingContactCount = 0;
  let contactSyncFailureCount = 0;
  let contactSyncTimeoutCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const members of groups.values()) {
    const leader = members[0];
    groupLeaderIdByReservationId.set(leader.id, leader.id);
    for (const follower of members.slice(1)) {
      groupLeaderIdByReservationId.set(follower.id, leader.id);
      if (follower.messages.length === 0) {
        await createSkippedFollower({
          reservationId: follower.id,
          phone: follower.phone,
          body: template.content,
          now,
        });
        skippedCount += 1;
      }
    }
  }

  for (const reservation of reservations) {
    const leaderId = groupLeaderIdByReservationId.get(reservation.id);
    if (leaderId && leaderId !== reservation.id) continue;
    if (reservation.messages.length > 0) continue;

    const phone = normalizeKoreanPhone(reservation.phone);
    if (!isValidKoreanMobilePhone(phone)) {
      waitingContactCount += 1;
      continue;
    }

    if (!options.contactSyncAlreadyAttempted) {
      const contactSync = await syncReservationContactImmediately(reservation.id, now);
      if (!contactSync.success) {
        contactSyncFailureCount += 1;
        if (contactSync.timedOut) contactSyncTimeoutCount += 1;
        console.warn(
          `[DawnBookingNotification] Google contact pre-send sync did not complete: reservation=${reservation.id}, timed-out=${contactSync.timedOut}, reason=${contactSync.reason || "unknown"}. SMS will continue.`,
        );
      }
    }

    const dedupeKey = messageDedupeKey(reservation.id);
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
          reservationId: reservation.id,
          occurredAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
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
    checkedCount: reservations.length,
    sentCount,
    dryRunCount,
    waitingContactCount,
    contactSyncFailureCount,
    contactSyncTimeoutCount,
    failedCount,
    skippedCount,
    ...recovery,
    pipelineMs: Date.now() - pipelineStartedAt,
    deferredUntil: null,
  };
}
