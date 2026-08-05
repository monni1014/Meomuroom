import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

type CandidateAction = "confirm" | "dismiss";

function getKstParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
  };
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/fake-block-candidates/[id]">,
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { action?: CandidateAction };
    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const candidate = await prisma.fakeBlockCandidate.findUnique({ where: { id } });
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    if (action === "dismiss") {
      await prisma.$transaction([
        prisma.fakeBlockCandidate.update({
          where: { id },
          data: { status: "DISMISSED", confirmedAt: null },
        }),
        prisma.adminAlert.updateMany({
          where: { dedupeKey: `fake-block:${id}` },
          data: { resolved: true },
        }),
      ]);
      revalidatePath("/");
      return NextResponse.json({ success: true, status: "DISMISSED" });
    }

    const start = getKstParts(candidate.startTime);
    const end = getKstParts(candidate.endTime);
    const endHour = candidate.endTime.getTime() > candidate.startTime.getTime()
      ? (end.day === start.day ? end.hour : 24)
      : start.hour;

    if (endHour <= start.hour) {
      return NextResponse.json({ error: "Invalid candidate time range" }, { status: 400 });
    }

    const existingCells = await prisma.manualTableCell.findMany({
      where: {
        tableId: "monthly-table",
        sectionId: candidate.roomName,
        year: start.year,
        month: start.month,
        day: start.day,
        cellKey: { in: Array.from({ length: endHour - start.hour }, (_, index) => `hour-${start.hour + index}`) },
      },
    });
    const existingByKey = new Map(existingCells.map((cell) => [cell.cellKey, cell]));
    const cellOperations = Array.from({ length: endHour - start.hour }, (_, index) => {
      const hour = start.hour + index;
      const cellKey = `hour-${hour}`;
      const existing = existingByKey.get(cellKey);
      return prisma.manualTableCell.upsert({
        where: {
          tableId_sectionId_year_month_day_cellKey: {
            tableId: "monthly-table",
            sectionId: candidate.roomName,
            year: start.year,
            month: start.month,
            day: start.day,
            cellKey,
          },
        },
        create: {
          tableId: "monthly-table",
          sectionId: candidate.roomName,
          year: start.year,
          month: start.month,
          day: start.day,
          cellKey,
          value: index === 0 ? "뻥카" : "",
          color: "fake-block",
        },
        update: {
          value: existing?.value || (index === 0 ? "뻥카" : ""),
          color: "fake-block",
        },
      });
    });

    await prisma.$transaction([
      ...cellOperations,
      prisma.fakeBlockCandidate.update({
        where: { id },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      }),
      prisma.adminAlert.updateMany({
        where: { dedupeKey: `fake-block:${id}` },
        data: { resolved: true },
      }),
    ]);

    revalidatePath("/");
    revalidatePath("/monthly-table");
    return NextResponse.json({ success: true, status: "CONFIRMED" });
  } catch (error) {
    console.error("Fake block candidate update error:", error);
    return NextResponse.json({ error: "Failed to update candidate" }, { status: 500 });
  }
}
