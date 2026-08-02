import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { lookupReservationReminderDelivery, sendReservationReminder } from "@/lib/solapi-sms";
import {
  recordOutboundReservationMessage,
  recordRecoveredReservationMessage,
} from "@/lib/customer-messages";
import { syncUpcomingReservationContacts } from "@/lib/google-people";
import { isValidKoreanMobilePhone } from "@/lib/phone-number";
import { RPA_PENDING_MARKER } from "@/lib/rpa-reservation-state";
import { buildReservationNotificationFailureAlert } from "@/lib/reservation-notification-failure-alert";
import { getKstDateParts, getKstDayRange } from "@/lib/kst-time";
import {
  buildReservationNotificationGroups,
  isContiguousReservationNotificationExtension,
  reservationNotificationGroupKey,
} from "@/lib/reservation-notification-grouping";
import {
  isReservationAutoSendActive,
  reservationNotificationRolloutStartsAt,
} from "@/lib/reservation-notification-rollout";
import { sendScheduledOnTimeExitWithGuide } from "@/lib/on-time-exit-notifications";

const ALERT_TYPE = "NOTIFICATION_DELIVERY";
const GOOGLE_PEOPLE_SYNC_ALERT_KEY = "google-people-sync";
const SEND_ATTEMPT_SETTING_PREFIX = "notification.sendAttempt.";
const GROUPING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function notificationAlertKey(reservationId: string) {
  return `notification-delivery:${reservationId}`;
}

function notificationAttemptKey(reservationId: string) {
  return `${SEND_ATTEMPT_SETTING_PREFIX}${reservationId}`;
}

type StoredNotificationAttempt = {
  attemptId: string;
  createdAt: string;
};

async function readNotificationAttempt(reservationId: string) {
  const setting = await prisma.appSetting.findUnique({
    where: { key: notificationAttemptKey(reservationId) },
    select: { value: true },
  });
  if (!setting) return null;

  try {
    const parsed = JSON.parse(setting.value) as Partial<StoredNotificationAttempt>;
    return typeof parsed.attemptId === "string" && parsed.attemptId
      ? parsed.attemptId
      : null;
  } catch {
    return null;
  }
}

function phoneLast4(phone: string | null) {
  return phone?.replace(/\D/g, "").slice(-4) || null;
}

function formatKstStartTime(value: Date) {
  const parts = getKstDateParts(value);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function notificationReadyMemoWhere() {
  return {
    OR: [
      { memo: null },
      { NOT: { memo: { contains: RPA_PENDING_MARKER } } },
    ],
  };
}

async function claimNotificationAttempt(reservationId: string) {
  const attemptId = randomUUID();
  const attempt: StoredNotificationAttempt = {
    attemptId,
    createdAt: new Date().toISOString(),
  };

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.reservation.updateMany({
      where: {
        id: reservationId,
        notified: false,
        notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "RECOVERING"] },
        status: "CONFIRMED",
        isNoShow: false,
        ...notificationReadyMemoWhere(),
      },
      data: {
        notificationStatus: "SENDING",
        notificationError: null,
      },
    });
    if (claimed.count === 0) return null;

    await tx.appSetting.upsert({
      where: { key: notificationAttemptKey(reservationId) },
      create: {
        key: notificationAttemptKey(reservationId),
        value: JSON.stringify(attempt),
      },
      update: { value: JSON.stringify(attempt) },
    });
    return attemptId;
  });
}

async function finalizeNotificationAttempt(
  reservationId: string,
  data: Parameters<typeof prisma.reservation.update>[0]["data"],
) {
  await prisma.$transaction([
    prisma.reservation.update({
      where: { id: reservationId },
      data,
    }),
    prisma.appSetting.deleteMany({
      where: { key: notificationAttemptKey(reservationId) },
    }),
  ]);
}

export async function sendDueReservationReminders() {
  const pipelineStartedAt = Date.now();
  const now = new Date();
  if (!isReservationAutoSendActive(now)) {
    return {
      success: true,
      checkedCount: 0,
      sentCount: 0,
      dryRunCount: 0,
      waitingContactCount: 0,
      waitingContactSyncCount: 0,
      contactSyncMs: 0,
      pipelineMs: Date.now() - pipelineStartedAt,
      failedCount: 0,
      recoveredCount: 0,
      recoveryWaitingCount: 0,
      groupedSkipCount: 0,
      results: [],
      deferredUntil: reservationNotificationRolloutStartsAt()?.toISOString() || null,
    };
  }
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  await prisma.reservation.updateMany({
    where: {
      notified: false,
      notificationStatus: "SENDING",
      updatedAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) },
    },
    data: {
      notificationStatus: "RECOVERING",
      notificationError: "이전 발송 작업이 중단되어 솔라피 발송 이력을 먼저 확인합니다.",
    },
  });

  const upcomingReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: now,
        lte: twoHoursLater,
      },
      notified: false,
      notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "RECOVERING"] },
      status: "CONFIRMED",
      isNoShow: false,
      ...notificationReadyMemoWhere(),
    },
    orderBy: { startTime: "asc" },
  });

  const upcomingDayRanges = upcomingReservations.map((reservation) => getKstDayRange(reservation.startTime));
  const groupCandidates = upcomingDayRanges.length > 0
    ? await prisma.reservation.findMany({
        where: {
          startTime: {
            gte: new Date(
              Math.min(...upcomingDayRanges.map((range) => range.start.getTime()))
              - GROUPING_LOOKBACK_MS,
            ),
            lte: new Date(Math.max(...upcomingDayRanges.map((range) => range.end.getTime()))),
          },
          status: "CONFIRMED",
          isNoShow: false,
        },
        orderBy: { startTime: "asc" },
      })
    : [];
  const notificationGroups = buildReservationNotificationGroups(groupCandidates);

  const resolveGroupLeader = (reservation: (typeof upcomingReservations)[number]) => {
    const groupKey = reservationNotificationGroupKey(reservation);
    const sameDayMembers = groupKey ? notificationGroups.get(groupKey) || [] : [];
    const sameDayLeader = sameDayMembers[0] || null;
    if (!sameDayLeader || sameDayLeader.id !== reservation.id) return sameDayLeader;

    const previousExtension = groupCandidates
      .filter((candidate) => (
        candidate.id !== reservation.id
        && isContiguousReservationNotificationExtension(candidate, reservation)
      ))
      .sort((left, right) => (
        right.startTime.getTime() - left.startTime.getTime()
        || right.id.localeCompare(left.id)
      ))[0];
    if (!previousExtension) return sameDayLeader;

    const previousGroupKey = reservationNotificationGroupKey(previousExtension);
    return previousGroupKey
      ? notificationGroups.get(previousGroupKey)?.[0] || previousExtension
      : previousExtension;
  };

  const results = [];
  let sentCount = 0;
  let dryRunCount = 0;
  let waitingContactCount = 0;
  const waitingContactSyncCount = 0;
  let failedCount = 0;
  let recoveredCount = 0;
  let recoveryWaitingCount = 0;
  let contactSyncMs = 0;
  let groupedSkipCount = 0;

  const skipGroupedFollowers = async (leader: (typeof upcomingReservations)[number]) => {
    const groupKey = reservationNotificationGroupKey(leader);
    const groupMembers = groupKey ? notificationGroups.get(groupKey) || [] : [];
    const followerIds = groupMembers.slice(1).map((member) => member.id);
    if (followerIds.length === 0) return;

    const skipReason = `같은 고객·같은 공간의 연속 예약 안내문자는 첫 예약 ${formatKstStartTime(leader.startTime)} 기준으로 한 번만 발송합니다.`;
    const skipped = await prisma.reservation.updateMany({
      where: {
        id: { in: followerIds },
        notified: false,
        notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "RECOVERING"] },
        status: "CONFIRMED",
        isNoShow: false,
      },
      data: {
        notificationStatus: "SKIPPED",
        notificationChannel: "SMS",
        notificationError: skipReason,
      },
    });
    groupedSkipCount += skipped.count;
    await Promise.all(followerIds.map((id) => resolveAdminAlertByDedupeKey(notificationAlertKey(id))));
  };

  const phoneReadyReservations = [];
  for (const reservation of upcomingReservations) {
    const groupLeader = resolveGroupLeader(reservation);
    if (groupLeader && groupLeader.id !== reservation.id) {
      const skipReason = `같은 고객·같은 공간의 연속 예약 안내문자는 첫 예약 ${formatKstStartTime(groupLeader.startTime)} 기준으로 한 번만 발송합니다.`;
      const skipped = await prisma.reservation.updateMany({
        where: {
          id: reservation.id,
          notified: false,
          notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "RECOVERING"] },
          status: "CONFIRMED",
          isNoShow: false,
        },
        data: {
          notificationStatus: "SKIPPED",
          notificationChannel: "SMS",
          notificationError: skipReason,
        },
      });
      if (skipped.count > 0) {
        await resolveAdminAlertByDedupeKey(notificationAlertKey(reservation.id));
        groupedSkipCount += 1;
        results.push({
          reservationId: reservation.id,
          customerName: reservation.customerName,
          roomName: reservation.roomName,
          startTime: reservation.startTime,
          phoneLast4: phoneLast4(reservation.phone),
          success: true,
          dryRun: false,
          channel: "SMS",
          skipped: true,
          error: skipReason,
        });
      }
      continue;
    }

    if (isValidKoreanMobilePhone(reservation.phone)) {
      phoneReadyReservations.push(reservation);
      continue;
    }

    await prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        notified: false,
        notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC", "RECOVERING"] },
        status: "CONFIRMED",
        isNoShow: false,
        ...notificationReadyMemoWhere(),
      },
      data: {
        notificationStatus: "WAITING_CONTACT",
        notificationChannel: "SMS",
        notificationError: "RPA에서 고객 전화번호가 채워지기를 기다리고 있습니다.",
      },
    });
    waitingContactCount += 1;
  }

  let contactSyncError: string | null = null;
  if (phoneReadyReservations.length > 0) {
    const contactSyncRequiredAfter = new Date();
    const contactSyncStartedAt = Date.now();
    try {
      const contactSync = await syncUpcomingReservationContacts(new Date(), {
        freshAfter: contactSyncRequiredAfter,
      });
      if (contactSync.skipped) {
        contactSyncError = contactSync.reason || "Google 연락처 계정이 연결되지 않았습니다.";
      }
    } catch (error) {
      contactSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      contactSyncMs = Date.now() - contactSyncStartedAt;
    }
  }

  if (contactSyncError) {
    try {
      await createAdminAlert({
        type: "GOOGLE_PEOPLE_SYNC_FAILED",
        severity: "WARNING",
        title: "Google 연락처 동기화 실패",
        message: `Google 연락처 동기화에 실패했지만 전화번호가 정상인 예약 안내문자는 계속 발송합니다. 연락처는 5분마다 다시 동기화합니다. 오류: ${contactSyncError}`,
        dedupeKey: GOOGLE_PEOPLE_SYNC_ALERT_KEY,
      });
    } catch (alertError) {
      console.error("[ReservationNotification] Failed to record Google Contacts warning:", alertError);
    }
  }

  for (const reservation of phoneReadyReservations) {
    if (reservation.notificationStatus === "RECOVERING") {
      const attemptId = await readNotificationAttempt(reservation.id);
      if (!attemptId) {
        const errorMessage = "저장된 발송 시도 번호가 없어 자동 재발송을 보류합니다.";
        await prisma.reservation.updateMany({
          where: {
            id: reservation.id,
            notified: false,
            notificationStatus: "RECOVERING",
          },
          data: { notificationError: errorMessage },
        });
        await createAdminAlert({
          type: ALERT_TYPE,
          severity: "WARNING",
          title: "문자 중복 확인 대기",
          message: `${reservation.customerName || "이름 없음"} / ${reservation.roomName} / ${errorMessage}`,
          dedupeKey: notificationAlertKey(reservation.id),
        });
        results.push({
          reservationId: reservation.id,
          customerName: reservation.customerName,
          roomName: reservation.roomName,
          startTime: reservation.startTime,
          phoneLast4: phoneLast4(reservation.phone),
          success: false,
          dryRun: false,
          channel: "SMS",
          recovered: false,
          error: errorMessage,
        });
        recoveryWaitingCount += 1;
        continue;
      }
      let recovered: Awaited<ReturnType<typeof lookupReservationReminderDelivery>>;
      try {
        recovered = await lookupReservationReminderDelivery({
          reservationId: reservation.id,
          notificationAttemptId: attemptId,
          phone: reservation.phone || "",
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await prisma.reservation.updateMany({
          where: {
            id: reservation.id,
            notified: false,
            notificationStatus: "RECOVERING",
          },
          data: {
            notificationError: `솔라피 발송 이력 확인 대기: ${errorMessage}`,
          },
        });
        await createAdminAlert({
          type: ALERT_TYPE,
          severity: "WARNING",
          title: "문자 중복 확인 대기",
          message: `${reservation.customerName || "이름 없음"} / ${reservation.roomName} / 솔라피 발송 이력을 확인하지 못해 중복 방지를 위해 재발송하지 않고 대기합니다. ${errorMessage}`,
          dedupeKey: notificationAlertKey(reservation.id),
        });
        results.push({
          reservationId: reservation.id,
          customerName: reservation.customerName,
          roomName: reservation.roomName,
          startTime: reservation.startTime,
          phoneLast4: phoneLast4(reservation.phone),
          success: false,
          dryRun: false,
          channel: "SMS",
          recovered: false,
          error: errorMessage,
        });
        recoveryWaitingCount += 1;
        continue;
      }

      if (recovered.found) {
        await recordRecoveredReservationMessage({
          reservationId: reservation.id,
          notificationAttemptId: attemptId,
          senderNumber: recovered.from,
          recipientNumber: recovered.to,
          body: recovered.text || "솔라피에서 복구한 예약 안내 문자",
          channel: recovered.channel,
          status: recovered.status,
          providerMessageId: recovered.providerMessageId,
          occurredAt: recovered.occurredAt,
        });

        await finalizeNotificationAttempt(reservation.id, {
          notified: true,
          notifiedAt: recovered.occurredAt,
          notificationStatus: recovered.status,
          notificationChannel: recovered.channel,
          notificationError: recovered.error,
        });

        results.push({
          reservationId: reservation.id,
          customerName: reservation.customerName,
          roomName: reservation.roomName,
          startTime: reservation.startTime,
          phoneLast4: phoneLast4(reservation.phone),
          success: recovered.status !== "FAILED",
          dryRun: false,
          channel: recovered.channel,
          recovered: true,
          error: recovered.error,
        });
        recoveredCount += 1;

        if (recovered.status === "FAILED") {
          const failureAlert = buildReservationNotificationFailureAlert({
            roomName: reservation.roomName,
            customerName: reservation.customerName,
            startTime: reservation.startTime,
            endTime: reservation.endTime,
            error: recovered.error || "솔라피 발송 실패",
          });
          await createAdminAlert({
            type: ALERT_TYPE,
            severity: "CRITICAL",
            title: failureAlert.title,
            message: failureAlert.message,
            dedupeKey: notificationAlertKey(reservation.id),
          });
          failedCount += 1;
        } else {
          await resolveAdminAlertByDedupeKey(notificationAlertKey(reservation.id));
          await skipGroupedFollowers(reservation);
          await sendScheduledOnTimeExitWithGuide(reservation.id, recovered.occurredAt).catch((error) => {
            console.error("[ReservationNotification] Scheduled on-time exit send failed:", error);
          });
          sentCount += 1;
        }
        continue;
      }
    }

    const notificationAttemptId = await claimNotificationAttempt(reservation.id);
    if (!notificationAttemptId) continue;

    const result = await sendReservationReminder({
      reservationId: reservation.id,
      notificationAttemptId,
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
      await finalizeNotificationAttempt(reservation.id, {
        notificationStatus: "DRY_RUN",
        notificationChannel: result.channel,
        notificationError: null,
      });
      dryRunCount += 1;
      continue;
    }

    if (result.success) {
      await finalizeNotificationAttempt(reservation.id, {
        notified: true,
        notifiedAt: new Date(),
        notificationStatus: "SUBMITTED",
        notificationChannel: result.channel,
        notificationError: null,
      });
      await resolveAdminAlertByDedupeKey(notificationAlertKey(reservation.id));
      await skipGroupedFollowers(reservation);
      await sendScheduledOnTimeExitWithGuide(reservation.id).catch((error) => {
        console.error("[ReservationNotification] Scheduled on-time exit send failed:", error);
      });
      sentCount += 1;
      continue;
    }

    if (!result.to) {
      const contactError = result.error || "Recipient phone number is missing.";
      await finalizeNotificationAttempt(reservation.id, {
        notificationStatus: "WAITING_CONTACT",
        notificationChannel: result.channel,
        notificationError: contactError,
      });
      waitingContactCount += 1;
      continue;
    }

    const errorMessage = result.error || "Unknown notification delivery failure.";
    await finalizeNotificationAttempt(reservation.id, {
      notificationStatus: "FAILED",
      notificationChannel: result.channel,
      notificationError: errorMessage,
    });
    const failureAlert = buildReservationNotificationFailureAlert({
      roomName: reservation.roomName,
      customerName: reservation.customerName,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      error: errorMessage,
    });
    await createAdminAlert({
      type: ALERT_TYPE,
      severity: "CRITICAL",
      title: failureAlert.title,
      message: failureAlert.message,
      dedupeKey: notificationAlertKey(reservation.id),
    });
    failedCount += 1;
  }

  return {
    success: failedCount === 0 && recoveryWaitingCount === 0,
    checkedCount: upcomingReservations.length,
    sentCount,
    dryRunCount,
    waitingContactCount,
    waitingContactSyncCount,
    contactSyncMs,
    pipelineMs: Date.now() - pipelineStartedAt,
    failedCount,
    recoveredCount,
    recoveryWaitingCount,
    groupedSkipCount,
    results,
    deferredUntil: null,
  };
}
