import { NextResponse } from "next/server";
import { sendDueReservationReminders } from "@/lib/reservation-notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await sendDueReservationReminders();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Reservation notification cron error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Internal Server Error" },
      { status: 500 },
    );
  }
}
