import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { eventIds?: unknown };
    if (!Array.isArray(body.eventIds) || body.eventIds.length === 0) {
      return NextResponse.json({ error: "확인할 경쟁사 이벤트가 없습니다." }, { status: 400 });
    }

    const eventIds = [...new Set(body.eventIds.filter((value): value is string => (
      typeof value === "string" && value.length > 0
    )))];
    if (eventIds.length === 0 || eventIds.length > 500) {
      return NextResponse.json({ error: "확인할 경쟁사 이벤트 범위가 올바르지 않습니다." }, { status: 400 });
    }

    const result = await prisma.competitorSlotEvent.updateMany({
      where: { id: { in: eventIds }, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });

    return NextResponse.json({ success: true, updated: result.count });
  } catch (error) {
    console.error("POST competitor event acknowledge error:", error);
    return NextResponse.json({ error: "경쟁사 신규 표시 확인에 실패했습니다." }, { status: 500 });
  }
}
