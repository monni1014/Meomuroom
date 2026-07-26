import { NextRequest, NextResponse } from "next/server";
import { runCompetitorScan, type CompetitorScanMode } from "@/lib/competitor-monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_MODES = new Set<CompetitorScanMode>(["daily", "weekly", "monthly", "range"]);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 45;

function parseDateKey(value: unknown) {
  const dateKey = typeof value === "string" ? value : "";
  if (!DATE_KEY_PATTERN.test(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) === dateKey
    ? { dateKey, date }
    : null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = String(body.mode || "daily") as CompetitorScanMode;
    if (!ALLOWED_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid competitor scan mode" }, { status: 400 });
    }

    if (mode === "range") {
      const start = parseDateKey(body.startKey);
      const end = parseDateKey(body.endKey);
      if (!start || !end || start.date > end.date) {
        return NextResponse.json({ error: "Invalid competitor scan range" }, { status: 400 });
      }
      const rangeDays = Math.round((end.date.getTime() - start.date.getTime()) / 86_400_000) + 1;
      if (rangeDays > MAX_RANGE_DAYS) {
        return NextResponse.json({ error: `Competitor scan range cannot exceed ${MAX_RANGE_DAYS} days` }, { status: 400 });
      }
      const result = await runCompetitorScan({
        mode,
        startKey: start.dateKey,
        endKey: end.dateKey,
      });
      return NextResponse.json(result);
    }

    const result = await runCompetitorScan({ mode });
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST competitor scan error:", error);
    const message = error instanceof Error ? error.message : "Competitor scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
