import { NextResponse } from "next/server";
import { getSolapiServiceStatus } from "@/lib/solapi-status";
import { normalizeSolapiPhone, saveSelectedSolapiSenderNumber } from "@/lib/solapi-sender-setting";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getSolapiServiceStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("Solapi status API error:", error);
    return NextResponse.json(
      { configured: false, error: error instanceof Error ? error.message : "Failed to load Solapi status" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const senderNumber = normalizeSolapiPhone(
      typeof body.senderNumber === "string" ? body.senderNumber : "",
    );
    if (!senderNumber) {
      return NextResponse.json({ success: false, error: "발신번호를 선택해주세요." }, { status: 400 });
    }

    const status = await getSolapiServiceStatus();
    const sender = status.senders.find((item) => item.phoneNumber === senderNumber);
    if (!sender) {
      return NextResponse.json(
        { success: false, error: "솔라피에 등록된 발신번호만 선택할 수 있습니다." },
        { status: 400 },
      );
    }
    if (sender.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: "현재 사용 가능한 발신번호만 선택할 수 있습니다." },
        { status: 400 },
      );
    }

    await saveSelectedSolapiSenderNumber(senderNumber);
    return NextResponse.json({
      success: true,
      status: {
        ...status,
        senderNumber,
        sender,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Solapi sender selection API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "발신번호를 저장하지 못했습니다." },
      { status: 500 },
    );
  }
}
