import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeKoreanPhone } from "@/lib/phone-number";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { customerPhone?: unknown };
    const customerPhone = normalizeKoreanPhone(
      typeof body.customerPhone === "string" ? body.customerPhone : "",
    );
    if (customerPhone.length < 9) {
      return NextResponse.json({ error: "Invalid customer phone" }, { status: 400 });
    }

    const result = await prisma.customerMessage.updateMany({
      where: {
        customerPhone,
        direction: "INBOUND",
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ success: true, updated: result.count });
  } catch (error) {
    console.error("PATCH message read state error:", error);
    return NextResponse.json({ error: "Failed to mark messages as read" }, { status: 500 });
  }
}
