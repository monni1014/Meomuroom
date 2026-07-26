import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateCleaningScheduleInput } from "@/lib/cleaning-schedule";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

export async function GET() {
  try {
    const schedules = await prisma.cleaningSchedule.findMany({
      orderBy: [{ startTime: "asc" }, { createdAt: "asc" }],
    });
    return NextResponse.json(schedules, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("GET cleaning schedules error:", error);
    return NextResponse.json(
      { error: "청소 일정을 불러오지 못했습니다." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  try {
    const validation = validateCleaningScheduleInput(await request.json());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const schedule = await prisma.cleaningSchedule.create({ data: validation.data });
    return NextResponse.json(schedule, { status: 201 });
  } catch (error) {
    console.error("POST cleaning schedule error:", error);
    return NextResponse.json({ error: "청소 일정을 저장하지 못했습니다." }, { status: 500 });
  }
}
