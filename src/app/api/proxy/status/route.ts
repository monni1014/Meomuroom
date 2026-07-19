import { NextResponse } from "next/server";
import { getProxySellerStatus } from "@/lib/proxy-seller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const status = await getProxySellerStatus({ force });
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
