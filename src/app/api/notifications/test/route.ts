import { NextResponse } from "next/server";
import { sendTestSms } from "@/lib/kakao";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const startTime = typeof body.startTime === "string" ? new Date(body.startTime) : undefined;
    const endTime = typeof body.endTime === "string" ? new Date(body.endTime) : undefined;
    const result = await sendTestSms(typeof body.to === "string" ? body.to : undefined, {
      customerName: typeof body.customerName === "string" ? body.customerName : undefined,
      roomName: typeof body.roomName === "string" ? body.roomName : undefined,
      startTime: startTime && !Number.isNaN(startTime.getTime()) ? startTime : undefined,
      endTime: endTime && !Number.isNaN(endTime.getTime()) ? endTime : undefined,
    });

    return NextResponse.json({
      success: result.success,
      dryRun: result.dryRun,
      channel: result.channel,
      toLast4: result.to ? result.to.slice(-4) : null,
      messageId: result.messageId,
      error: result.error,
    }, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to send test notification" },
      { status: 500 },
    );
  }
}
