import { prisma } from "@/lib/prisma";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { sendReservationReminder } from "@/lib/solapi-sms";
import { recordOutboundReservationMessage } from "@/lib/customer-messages";
import { syncUpcomingReservationContacts } from "@/lib/google-people";
import { isValidKoreanMobilePhone } from "@/lib/phone-number";
import { RPA_PENDING_MARKER } from "@/lib/rpa-reservation-state";

const ALERT_TYPE = "NOTIFICATION_DELIVERY";
const GOOGLE_PEOPLE_SYNC_ALERT_KEY = "google-people-sync";

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

function notificationReadyMemoWhere() {
  return {
    OR: [
      { memo: null },
      { NOT: { memo: { contains: RPA_PENDING_MARKER } } },
    ],
  };
}

export async function sendDueReservationReminders() {
  const pipelineStartedAt = Date.now();
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  await prisma.reservation.updateMany({
    where: {
      notified: false,
      notificationStatus: "SENDING",
      updatedAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) },
    },
    data: {
      notificationStatus: "PENDING",
      notificationError: "이전 발송 작업이 중단되어 자동으로 다시 확인합니다.",
    },
  });

  const upcomingReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: now,
        lte: twoHoursLater,
      },
      notified: false,
      notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"] },
      status: "CONFIRMED",
      isNoShow: false,
      ...notificationReadyMemoWhere(),
    },
    orderBy: { startTime: "asc" },
  });

  const results = [];
  let sentCount = 0;
  let dryRunCount = 0;
  let waitingContactCount = 0;
  const waitingContactSyncCount = 0;
  let failedCount = 0;
  let contactSyncMs = 0;

  const phoneReadyReservations = [];
  for (const reservation of upcomingReservations) {
    if (isValidKoreanMobilePhone(reservation.phone)) {
      phoneReadyReservations.push(reservation);
      continue;
    }

    await prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        notified: false,
        notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"] },
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
    const claimed = await prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        notified: false,
        notificationStatus: { in: ["PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"] },
        status: "CONFIRMED",
        isNoShow: false,
        ...notificationReadyMemoWhere(),
      },
      data: {
        notificationStatus: "SENDING",
        notificationError: null,
      },
    });
    if (claimed.count === 0) continue;

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

    if (!result.to) {
      const contactError = result.error || "Recipient phone number is missing.";
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          notificationStatus: "WAITING_CONTACT",
          notificationChannel: result.channel,
          notificationError: contactError,
        },
      });
      waitingContactCount += 1;
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
    waitingContactCount,
    waitingContactSyncCount,
    contactSyncMs,
    pipelineMs: Date.now() - pipelineStartedAt,
    failedCount,
    results,
  };
}
