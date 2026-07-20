import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const count = await prisma.customerMessage.count({
      where: { direction: "INBOUND", readAt: null },
    });
    return NextResponse.json(
      { count },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET unread message count error:", error);
    return NextResponse.json({ error: "Failed to count unread messages" }, { status: 500 });
  }
}
