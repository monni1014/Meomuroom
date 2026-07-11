import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const result = await prisma.adminAlert.updateMany({
      where: { id, resolved: false },
      data: { dismissedAt: new Date() },
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Admin alert dismiss error:", error);
    return NextResponse.json({ error: "Failed to dismiss alert" }, { status: 500 });
  }
}
