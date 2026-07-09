import { NextResponse } from "next/server";
import { getSolapiServiceStatus } from "@/lib/solapi-status";

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
