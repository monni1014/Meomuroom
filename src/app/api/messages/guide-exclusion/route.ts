import { NextResponse } from "next/server";
import { resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import {
  EXCLUDABLE_GUIDE_NOTIFICATION_STATUSES,
  MANUAL_GUIDE_EXCLUSION_REASON,
  isManualGuideNotificationExclusion,
} from "@/lib/guide-notification-exclusion";
import { prisma } from "@/lib/prisma";
import { onTimeExitGuideScheduleKey } from "@/lib/on-time-exit-notifications";

export const dynamic = "force-dynamic";

const reminderMessageWhere = {
  direction: "OUTBOUND" as const,
  OR: [
    { dedupeKey: { startsWith: "reservation-reminder:" } },
    { dedupeKey: { startsWith: "reservation-test:" } },
  ],
};

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const reservationId = typeof body.reservationId === "string"
      ? body.reservationId.trim()
      : "";
    const excluded = body.excluded;

    if (!reservationId || typeof excluded !== "boolean") {
      return NextResponse.json(
        { success: false, error: "예약과 문자 제외 여부를 확인해 주세요." },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          startTime: true,
          status: true,
          notified: true,
          notificationStatus: true,
          notificationError: true,
          messages: {
            where: reminderMessageWhere,
            select: { id: true },
            take: 1,
          },
        },
      });

      if (!reservation) {
        return { statusCode: 404, error: "예약을 찾을 수 없습니다." };
      }

      if (excluded) {
        if (reservation.messages.length > 0 || reservation.notified) {
          return { statusCode: 409, error: "이미 발송된 안내문자는 제외할 수 없습니다." };
        }
        if (reservation.status !== "CONFIRMED") {
          return { statusCode: 409, error: "확정 예약만 안내문자에서 제외할 수 있습니다." };
        }

        const updated = await tx.reservation.updateMany({
          where: {
            id: reservationId,
            status: "CONFIRMED",
            notified: false,
            notificationStatus: { in: [...EXCLUDABLE_GUIDE_NOTIFICATION_STATUSES] },
          },
          data: {
            notificationStatus: "SKIPPED",
            notificationChannel: "SMS",
            notificationError: MANUAL_GUIDE_EXCLUSION_REASON,
          },
        });
        if (updated.count === 0) {
          return {
            statusCode: 409,
            error: "문자 발송이 이미 시작됐거나 현재 상태에서는 제외할 수 없습니다. 새로고침 후 확인해 주세요.",
          };
        }

        await tx.appSetting.deleteMany({
          where: {
            key: {
              in: [
                `notification.sendAttempt.${reservationId}`,
                onTimeExitGuideScheduleKey(reservationId),
              ],
            },
          },
        });
        return { statusCode: 200, excluded: true };
      }

      if (!isManualGuideNotificationExclusion(reservation)) {
        return { statusCode: 409, error: "직접 제외한 안내문자만 다시 발송 대상으로 바꿀 수 있습니다." };
      }
      if (reservation.status !== "CONFIRMED" || reservation.startTime.getTime() <= Date.now()) {
        return { statusCode: 409, error: "이미 시작했거나 취소된 예약은 다시 발송 대상으로 바꿀 수 없습니다." };
      }

      const updated = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          status: "CONFIRMED",
          notified: false,
          notificationStatus: "SKIPPED",
          notificationError: MANUAL_GUIDE_EXCLUSION_REASON,
        },
        data: {
          notificationStatus: "PENDING",
          notificationChannel: null,
          notificationError: null,
          notifiedAt: null,
        },
      });
      if (updated.count === 0) {
        return { statusCode: 409, error: "발송 제외 상태가 변경되었습니다. 새로고침 후 확인해 주세요." };
      }
      return { statusCode: 200, excluded: false };
    });

    if ("error" in result) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.statusCode });
    }

    if (result.excluded) {
      await resolveAdminAlertByDedupeKey(`notification-delivery:${reservationId}`).catch((error) => {
        console.error("Could not resolve excluded notification alert:", error);
      });
    }

    return NextResponse.json({ success: true, excluded: result.excluded });
  } catch (error) {
    console.error("Guide notification exclusion error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "안내문자 설정을 변경하지 못했습니다." },
      { status: 500 },
    );
  }
}
