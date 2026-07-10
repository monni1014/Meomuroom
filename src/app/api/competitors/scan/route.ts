import { NextRequest, NextResponse } from "next/server";
import { runCompetitorScan, type CompetitorScanMode } from "@/lib/competitor-monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_MODES = new Set<CompetitorScanMode>(["daily", "weekly", "monthly"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = String(body.mode || "daily") as CompetitorScanMode;
    if (!ALLOWED_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid competitor scan mode" }, { status: 400 });
    }

    const result = await runCompetitorScan({ mode });
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST competitor scan error:", error);
    const message = error instanceof Error ? error.message : "Competitor scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
