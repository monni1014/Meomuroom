import { NextResponse } from "next/server";
import { createProxyPayment, deleteProxyPayment, getProxyPayments } from "@/lib/proxy-payments";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ success: true, payments: await getProxyPayments() });
  } catch (error) {
    console.error("Proxy payments GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "결제 내역을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const payment = await createProxyPayment(body);
    return NextResponse.json({ success: true, payment });
  } catch (error) {
    console.error("Proxy payments POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "결제 내역을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    await deleteProxyPayment(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Proxy payments DELETE error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "결제 내역을 삭제하지 못했습니다." },
      { status: 400 },
    );
  }
}
