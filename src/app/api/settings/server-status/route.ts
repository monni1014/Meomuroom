import { getServerStatus } from "@/lib/server-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getServerStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Server status API error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "클라우드 컴퓨터 상태를 확인하지 못했습니다.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
