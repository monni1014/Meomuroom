import { getPlannedRestartReadiness } from "@/lib/planned-restart-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getPlannedRestartReadiness(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      idle: false,
      reasons: ["readiness-check-failed"],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
