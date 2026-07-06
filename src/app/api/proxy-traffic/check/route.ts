import { NextResponse } from "next/server";
import { checkIproyalTrafficAndAlert } from "@/lib/iproyal-traffic";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await checkIproyalTrafficAndAlert();
    return NextResponse.json(status);
  } catch (error) {
    console.error("Proxy traffic check API error:", error);
    return NextResponse.json({ error: "Failed to check proxy traffic" }, { status: 500 });
  }
}
