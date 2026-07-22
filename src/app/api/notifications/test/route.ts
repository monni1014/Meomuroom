import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sendTestSms } from "@/lib/solapi-sms";
import { recordOutboundTestMessage } from "@/lib/customer-messages";
import { normalizeKoreanPhone } from "@/lib/phone-number";

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
    const requestedTo = typeof body.to === "string" ? normalizeKoreanPhone(body.to) : "";
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
    const startTime = typeof body.startTime === "string" ? new Date(body.startTime) : undefined;
    const endTime = typeof body.endTime === "string" ? new Date(body.endTime) : undefined;
    const result = await sendTestSms(requestedTo || undefined, {
      customerName: typeof body.customerName === "string" ? body.customerName : undefined,
      roomName: typeof body.roomName === "string" ? body.roomName : undefined,
      startTime: startTime && !Number.isNaN(startTime.getTime()) ? startTime : undefined,
      endTime: endTime && !Number.isNaN(endTime.getTime()) ? endTime : undefined,
    }, { forceRealSend: realSend });

    const message = result.to && result.text
      ? await recordOutboundTestMessage({
          senderNumber: result.from,
          recipientNumber: result.to,
          body: result.text,
          channel: result.channel,
          status: result.success ? (result.dryRun ? "DRY_RUN" : "SUBMITTED") : "FAILED",
          providerMessageId: result.messageId,
        })
      : null;

    return NextResponse.json({
      success: result.success,
      dryRun: result.dryRun,
      channel: result.channel,
      toLast4: result.to ? result.to.slice(-4) : null,
      messageId: result.messageId,
      testRecordId: message?.id || null,
      error: result.error,
    }, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to send test notification" },
      { status: 500 },
    );
  }
}
