import { NextRequest, NextResponse } from "next/server";
import { applyReviewSlotSalesMode } from "@/lib/naver-rpa-sync";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const allowed = body.allowed;

    if (typeof allowed !== "boolean") {
      return NextResponse.json({ error: "allowed 값이 필요합니다." }, { status: 400 });
    }

    const reservation = await prisma.reservation.findUnique({ where: { id } });
    if (!reservation) {
      return NextResponse.json({ error: "예약을 찾을 수 없습니다." }, { status: 404 });
    }
    if (!["naver", "spacecloud"].includes(reservation.source) || reservation.status !== "CONFIRMED") {
      return NextResponse.json(
        { error: "확정된 네이버·스클 예약만 설정할 수 있습니다." },
        { status: 400 },
      );
    }

    await prisma.reservation.update({
      where: { id },
      data: {
        reviewSlotSalesAllowed: allowed,
        reviewSlotSalesStatus: allowed ? "OPENING" : "CLOSING",
        reviewSlotSalesError: null,
        reviewSlotSalesChangedAt: new Date(),
      },
    });

    void applyReviewSlotSalesMode(id, allowed).catch((error) => {
      console.error(`[Review slot sales] Background update failed for ${id}:`, error);
    });

    return NextResponse.json({ ok: true, allowed, status: allowed ? "OPENING" : "CLOSING" });
  } catch (error) {
    console.error("Review slot sales update failed:", error);
    return NextResponse.json({ error: "리뷰용 슬롯 판매 설정에 실패했습니다." }, { status: 500 });
  }
}
