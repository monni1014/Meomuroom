import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildReservationReminder, sendTestSms } from "@/lib/solapi-sms";
import {
  finalizeOutboundTestMessage,
  recordOutboundTestMessage,
} from "@/lib/customer-messages";
import { getSelectedSolapiSenderNumber } from "@/lib/solapi-sender-setting";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";

export const dynamic = "force-dynamic";

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const realSend = body.realSend === true;
    const reservationId = typeof body.reservationId === "string" ? body.reservationId.trim() : "";
    if (!reservationId) {
      return NextResponse.json(
        { success: false, error: "강제 테스트 발송은 연결할 예약을 반드시 선택해야 합니다." },
        { status: 400 },
      );
    }

    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) {
      return NextResponse.json({ success: false, error: "연결할 예약을 찾을 수 없습니다." }, { status: 404 });
    }
    if (reservation.status !== "CONFIRMED") {
      return NextResponse.json(
        { success: false, error: "취소된 예약에는 강제 테스트 문자를 보낼 수 없습니다." },
        { status: 400 },
      );
    }

    const reservationPhone = normalizeKoreanPhone(reservation.phone);
    const requestedTo = typeof body.to === "string"
      ? normalizeKoreanPhone(body.to)
      : reservationPhone;
    if (!isValidKoreanMobilePhone(reservationPhone)) {
      return NextResponse.json(
        { success: false, error: "선택한 예약에 정상적인 고객 전화번호가 없습니다." },
        { status: 400 },
      );
    }
    if (requestedTo !== reservationPhone) {
      return NextResponse.json(
        { success: false, error: "테스트 수신번호는 선택한 예약의 고객 전화번호와 같아야 합니다." },
        { status: 400 },
      );
    }

    if (realSend) {
      const secret = env("SOLAPI_WEBHOOK_SECRET");
      const receivedSecret = request.headers.get("x-memoroom-test-secret") || "";
      if (!secret || !secureEqual(receivedSecret, secret)) {
        return NextResponse.json({ success: false, error: "Unauthorized test send" }, { status: 401 });
      }

      const allowedRecipients = new Set(
        [env("SOLAPI_TEST_TO"), env("OWNER_PHONE")].map(normalizeKoreanPhone).filter(Boolean),
      );
      if (!requestedTo || !allowedRecipients.has(requestedTo)) {
        return NextResponse.json(
          { success: false, error: "실발송 테스트는 등록된 테스트 번호로만 보낼 수 있습니다." },
          { status: 400 },
        );
      }
    }
    const notificationAttemptId = randomUUID();
    const reminderInput = {
      reservationId: reservation.id,
      notificationAttemptId,
      customerName: reservation.customerName,
      phone: reservationPhone,
      roomName: reservation.roomName,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
    };
    const preview = await buildReservationReminder(reminderInput);
    const senderNumber = await getSelectedSolapiSenderNumber();
    if (!senderNumber) {
      return NextResponse.json(
        { success: false, error: "문자 발신번호가 설정되지 않았습니다." },
        { status: 400 },
      );
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const reservationClaim = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          status: "CONFIRMED",
          notificationStatus: { notIn: ["SENDING", "RECOVERING"] },
        },
        data: {
          notified: false,
          notificationStatus: "SENDING",
          notificationChannel: "SMS",
          notificationError: null,
        },
      });
      if (reservationClaim.count === 0) return false;

      await tx.appSetting.upsert({
        where: { key: `notification.sendAttempt.${reservation.id}` },
        create: {
          key: `notification.sendAttempt.${reservation.id}`,
          value: JSON.stringify({
            attemptId: notificationAttemptId,
            createdAt: new Date().toISOString(),
            kind: "FORCED_TEST",
          }),
        },
        update: {
          value: JSON.stringify({
            attemptId: notificationAttemptId,
            createdAt: new Date().toISOString(),
            kind: "FORCED_TEST",
          }),
        },
      });
      return true;
    });
    if (!claimed) {
      return NextResponse.json(
        { success: false, error: "이 예약의 문자 발송 또는 중복 확인이 이미 진행 중입니다." },
        { status: 409 },
      );
    }

    await recordOutboundTestMessage({
      reservationId: reservation.id,
      notificationAttemptId,
      senderNumber,
      recipientNumber: reservationPhone,
      body: preview.text,
      channel: "SMS",
      status: "SENDING",
    });

    const result = await sendTestSms(requestedTo || undefined, {
      ...reminderInput,
    }, { forceRealSend: realSend, forceDryRun: !realSend });

    const message = await finalizeOutboundTestMessage({
      reservationId: reservation.id,
      notificationAttemptId,
      senderNumber: result.from || senderNumber,
      recipientNumber: result.to || reservationPhone,
      body: result.text || preview.text,
      channel: result.channel,
      status: result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED",
      providerMessageId: result.messageId,
    });

    const effectiveStatus = message.status;
    await prisma.$transaction([
      prisma.reservation.update({
        where: { id: reservation.id },
        data: result.dryRun
          ? {
              notified: reservation.notified,
              notifiedAt: reservation.notifiedAt,
              notificationStatus: reservation.notificationStatus,
              notificationChannel: reservation.notificationChannel,
              notificationError: reservation.notificationError,
            }
          : {
              notified: effectiveStatus !== "FAILED",
              notifiedAt: effectiveStatus !== "FAILED" ? new Date() : reservation.notifiedAt,
              notificationStatus: effectiveStatus,
              notificationChannel: result.channel,
              notificationError: result.error || null,
            },
      }),
      prisma.appSetting.deleteMany({
        where: { key: `notification.sendAttempt.${reservation.id}` },
      }),
    ]);

    return NextResponse.json({
      success: result.success,
      reservationId: reservation.id,
      linkedToReservation: true,
      dryRun: result.dryRun,
      channel: result.channel,
      toLast4: result.to ? result.to.slice(-4) : null,
      messageId: result.messageId,
      testRecordId: message.id,
      error: result.error,
    }, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to send test notification" },
      { status: 500 },
    );
  }
}
