import { NextResponse } from "next/server";
import { sendManualOnTimeExitMessage } from "@/lib/on-time-exit-notifications";

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

    const result = await sendManualOnTimeExitMessage(reservationId);
    return NextResponse.json(result, { status: result.statusCode });
  } catch (error) {
    console.error("Manual on-time exit notification error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "정시퇴실 문자 발송에 실패했습니다." },
      { status: 500 },
    );
  }
}
