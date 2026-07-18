import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const result = await prisma.competitorEvidence.updateMany({
      where: { id, dismissedAt: null },
      data: {
        status: "DISMISSED",
        dismissedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Evidence not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Competitor evidence dismiss error:", error);
    return NextResponse.json({ error: "Failed to dismiss competitor evidence" }, { status: 500 });
  }
}
