import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getKstDateKey } from "@/lib/kst-time";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

function dateStamp(value: Date | null | undefined) {
  return value?.getTime() ?? 0;
}

async function getReservationVersion() {
  const [reservations, usageLogs] = await Promise.all([
    prisma.reservation.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.usageLog.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ]);

  return [
    getKstDateKey(),
    reservations._count._all,
    dateStamp(reservations._max.updatedAt),
    usageLogs._count._all,
    dateStamp(usageLogs._max.updatedAt),
  ].join(":");
}

function parseYearMonth(request: NextRequest) {
  const year = Number(request.nextUrl.searchParams.get("year"));
  const month = Number(request.nextUrl.searchParams.get("month"));
  return {
    year: Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : undefined,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : undefined,
  };
}

async function getManualCellVersion(tableId: string, year?: number, month?: number) {
  const cells = await prisma.manualTableCell.aggregate({
    where: {
      tableId,
      ...(year ? { year } : {}),
      ...(month ? { month } : {}),
    },
    _count: { _all: true },
    _max: { updatedAt: true },
  });

  return `${cells._count._all}:${dateStamp(cells._max.updatedAt)}`;
}

async function getDashboardVersion() {
  const [reservationVersion, alerts] = await Promise.all([
    getReservationVersion(),
    prisma.adminAlert.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ]);

  return [reservationVersion, alerts._count._all, dateStamp(alerts._max.updatedAt)].join(":");
}

async function getMessageVersion() {
  const [messages, reservations] = await Promise.all([
    prisma.customerMessage.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.reservation.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ]);

  return [
    messages._count._all,
    dateStamp(messages._max.updatedAt),
    reservations._count._all,
    dateStamp(reservations._max.updatedAt),
  ].join(":");
}

async function getCompetitorVersion(year?: number, month?: number) {
  const [scans, slots, events, evidence, manualCells] = await Promise.all([
    prisma.competitorScan.aggregate({
      _count: { _all: true },
      _max: { startedAt: true, finishedAt: true },
    }),
    prisma.competitorSlot.aggregate({
      _count: { _all: true },
      _max: { lastCheckedAt: true, lastChangedAt: true },
    }),
    prisma.competitorSlotEvent.aggregate({
      _count: { _all: true },
      _max: { occurredAt: true, acknowledgedAt: true },
    }),
    prisma.competitorEvidence.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    getManualCellVersion("competitors", year, month),
  ]);

  return [
    scans._count._all,
    dateStamp(scans._max.startedAt),
    dateStamp(scans._max.finishedAt),
    slots._count._all,
    dateStamp(slots._max.lastCheckedAt),
    dateStamp(slots._max.lastChangedAt),
    events._count._all,
    dateStamp(events._max.occurredAt),
    dateStamp(events._max.acknowledgedAt),
    evidence._count._all,
    dateStamp(evidence._max.updatedAt),
    manualCells,
  ].join(":");
}

export async function GET(request: NextRequest) {
  try {
    const scope = request.nextUrl.searchParams.get("scope") || "reservations";
    const { year, month } = parseYearMonth(request);

    let version: string;
    switch (scope) {
      case "dashboard":
        version = await getDashboardVersion();
        break;
      case "monthly-table": {
        const [reservationVersion, manualCellVersion] = await Promise.all([
          getReservationVersion(),
          getManualCellVersion("monthly-table", year, month),
        ]);
        version = `${reservationVersion}:${manualCellVersion}`;
        break;
      }
      case "competitors":
        version = await getCompetitorVersion(year, month);
        break;
      case "reservations":
        version = await getReservationVersion();
        break;
      case "messages":
        version = await getMessageVersion();
        break;
      default:
        return NextResponse.json({ error: "Unsupported data-version scope" }, { status: 400 });
    }

    return NextResponse.json({ version }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("GET data version error:", error);
    return NextResponse.json(
      { error: "Failed to check screen data version" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
