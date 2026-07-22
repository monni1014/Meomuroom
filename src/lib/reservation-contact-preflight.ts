import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { isValidKoreanMobilePhone } from "@/lib/phone-number";
import { prisma } from "@/lib/prisma";

const ALERT_TYPE = "RESERVATION_CONTACT_MISSING";
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTACT_LOOKAHEAD_DAYS = 7;

function alertKey(reservationId: string) {
  return `reservation-contact:${reservationId}`;
}

function formatKstDateTime(value: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

export async function runReservationContactPreflight(now = new Date()) {
  const lookaheadEnd = new Date(now.getTime() + CONTACT_LOOKAHEAD_DAYS * DAY_MS);
  const reservations = await prisma.reservation.findMany({
    where: {
      status: "CONFIRMED",
      isNoShow: false,
      startTime: {
        gt: now,
        lte: lookaheadEnd,
      },
    },
    select: {
      id: true,
      source: true,
      roomName: true,
      startTime: true,
      phone: true,
      emailId: true,
    },
    orderBy: { startTime: "asc" },
  });

  const missing = reservations.filter((reservation) => !isValidKoreanMobilePhone(reservation.phone));
  const missingKeys = new Set(missing.map((reservation) => alertKey(reservation.id)));

  for (const reservation of missing) {
    const hoursUntilStart = (reservation.startTime.getTime() - now.getTime()) / (60 * 60 * 1000);
    const severity = hoursUntilStart <= 24 ? "CRITICAL" : "WARNING";
    const dedupeKey = alertKey(reservation.id);
    const message = `${reservation.roomName} / ${formatKstDateTime(reservation.startTime)} / ${reservation.source} 예약의 고객번호가 없어 2시간 전 안내를 보낼 수 없습니다.`;
    const existing = await prisma.adminAlert.findUnique({ where: { dedupeKey } });
    if (existing && !existing.resolved) {
      if (existing.severity !== severity || existing.message !== message) {
        await prisma.adminAlert.update({
          where: { id: existing.id },
          data: { severity, message, dismissedAt: null },
        });
      }
      continue;
    }
    await createAdminAlert({
      type: ALERT_TYPE,
      severity,
      title: "예약 고객번호 확인 필요",
      message,
      dedupeKey,
    });
  }

  const unresolved = await prisma.adminAlert.findMany({
    where: { type: ALERT_TYPE, resolved: false },
    select: { dedupeKey: true },
  });
  for (const alert of unresolved) {
    if (alert.dedupeKey && !missingKeys.has(alert.dedupeKey)) {
      await resolveAdminAlertByDedupeKey(alert.dedupeKey);
    }
  }

  return {
    checkedCount: reservations.length,
    missingCount: missing.length,
    recoverableCount: missing.filter(
      (reservation) => ["naver", "spacecloud"].includes(reservation.source) && Boolean(reservation.emailId),
    ).length,
    criticalCount: missing.filter(
      (reservation) => reservation.startTime.getTime() - now.getTime() <= DAY_MS,
    ).length,
  };
}
