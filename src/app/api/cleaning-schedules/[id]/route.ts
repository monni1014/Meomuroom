import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseCleaningRoomNames, validateCleaningScheduleInput } from "@/lib/cleaning-schedule";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const validation = validateCleaningScheduleInput(await request.json());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const existing = await prisma.cleaningSchedule.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "일정을 찾을 수 없습니다." }, { status: 404 });
    }

    const schedule = await prisma.cleaningSchedule.update({
      where: { id },
      data: validation.data,
    });
    return NextResponse.json({
      ...schedule,
      roomNames: parseCleaningRoomNames(schedule.roomName),
    });
  } catch (error) {
    console.error("PATCH cleaning schedule error:", error);
    return NextResponse.json({ error: "일정을 수정하지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const existing = await prisma.cleaningSchedule.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "일정을 찾을 수 없습니다." }, { status: 404 });
    }

    await prisma.cleaningSchedule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE cleaning schedule error:", error);
    return NextResponse.json({ error: "일정을 삭제하지 못했습니다." }, { status: 500 });
  }
}
