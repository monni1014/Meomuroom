import { NextResponse } from "next/server";
import {
  cancelAllOnTimeExitSchedules,
  cancelOnTimeExitAt,
  cancelOnTimeExitWithGuide,
  scheduleOnTimeExitAt,
  scheduleOnTimeExitWithGuide,
  sendManualOnTimeExitMessage,
} from "@/lib/on-time-exit-notifications";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const reservationId = typeof body.reservationId === "string"
      ? body.reservationId.trim()
      : "";
    if (!reservationId) {
      return NextResponse.json(
        { success: false, error: "예약을 선택해 주세요." },
        { status: 400 },
      );
    }

    const action = typeof body.action === "string" ? body.action : "SEND_NOW";
    let result;
    if (action === "SCHEDULE_WITH_GUIDE") {
      result = await scheduleOnTimeExitWithGuide(reservationId);
    } else if (action === "SCHEDULE_AT") {
      const time = typeof body.time === "string" ? body.time.trim() : "";
      result = await scheduleOnTimeExitAt(reservationId, time);
    } else if (action === "CANCEL_GUIDE_SCHEDULE") {
      result = await cancelOnTimeExitWithGuide(reservationId);
    } else if (action === "CANCEL_TIMED_SCHEDULE") {
      result = await cancelOnTimeExitAt(reservationId);
    } else if (action === "SEND_NOW") {
      result = await sendManualOnTimeExitMessage(reservationId);
      await cancelAllOnTimeExitSchedules(reservationId);
    } else {
      return NextResponse.json(
        { success: false, error: "지원하지 않는 정시퇴실 문자 작업입니다." },
        { status: 400 },
      );
    }
    return NextResponse.json(result, { status: result.statusCode });
  } catch (error) {
    console.error("Manual on-time exit notification error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "정시퇴실 문자 발송에 실패했습니다." },
      { status: 500 },
    );
  }
}
