import { NextResponse } from "next/server";
import { getGooglePeopleStatus, syncUpcomingReservationContacts } from "@/lib/google-people";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getGooglePeopleStatus());
  } catch (error) {
    console.error("Google People status API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Google 연락처 상태를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const result = await syncUpcomingReservationContacts();
    return NextResponse.json({ success: true, result, status: await getGooglePeopleStatus() });
  } catch (error) {
    console.error("Google People sync API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Google 연락처 동기화에 실패했습니다." },
      { status: 500 },
    );
  }
}
