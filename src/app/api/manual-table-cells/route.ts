import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function requireNumber(value: string | null, field: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid ${field}`);
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tableId = searchParams.get("tableId");
    const sectionId = searchParams.get("sectionId") || undefined;
    const year = requireNumber(searchParams.get("year"), "year");
    const month = requireNumber(searchParams.get("month"), "month");

    if (!tableId) {
      return NextResponse.json({ error: "tableId is required" }, { status: 400 });
    }

    const cells = await prisma.manualTableCell.findMany({
      where: {
        tableId,
        sectionId,
        year,
        month,
      },
      orderBy: [{ sectionId: "asc" }, { day: "asc" }, { cellKey: "asc" }],
    });

    return NextResponse.json(cells, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("GET manual table cells error:", error);
    return NextResponse.json({ error: "Failed to fetch manual table cells" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const tableId = String(body.tableId || "").trim();
    const sectionId = String(body.sectionId || "").trim();
    const year = Number(body.year);
    const month = Number(body.month);
    const day = Number(body.day);
    const cellKey = String(body.cellKey || "").trim();
    const value = String(body.value || "").trim();
    const color = body.color ? String(body.color).trim() : null;

    if (!tableId || !sectionId || !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || !cellKey) {
      return NextResponse.json({ error: "Invalid manual cell payload" }, { status: 400 });
    }

    const key = {
      tableId_sectionId_year_month_day_cellKey: {
        tableId,
        sectionId,
        year,
        month,
        day,
        cellKey,
      },
    };

    if (!value && !color) {
      await prisma.manualTableCell.deleteMany({
        where: {
          tableId,
          sectionId,
          year,
          month,
          day,
          cellKey,
        },
      });
      return NextResponse.json({ deleted: true });
    }

    const cell = await prisma.manualTableCell.upsert({
      where: key,
      create: {
        tableId,
        sectionId,
        year,
        month,
        day,
        cellKey,
        value,
        color,
      },
      update: {
        value,
        color,
      },
    });

    return NextResponse.json(cell);
  } catch (error) {
    console.error("POST manual table cell error:", error);
    return NextResponse.json({ error: "Failed to save manual table cell" }, { status: 500 });
  }
}
