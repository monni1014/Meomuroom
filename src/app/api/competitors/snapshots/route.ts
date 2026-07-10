import { NextRequest, NextResponse } from "next/server";
import { getCompetitorSnapshots } from "@/lib/competitor-snapshots";

export const dynamic = "force-dynamic";

function requireInteger(value: string | null, field: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid ${field}`);
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const year = requireInteger(searchParams.get("year"), "year");
    const month = requireInteger(searchParams.get("month"), "month");
    return NextResponse.json(await getCompetitorSnapshots(year, month));
  } catch (error) {
    console.error("GET competitor snapshots error:", error);
    const message = error instanceof Error ? error.message : "Failed to fetch competitor snapshots";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
