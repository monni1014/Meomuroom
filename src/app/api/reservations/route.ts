import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const reservations = await prisma.reservation.findMany({
      include: {
        usageLog: true,
      },
      orderBy: {
        startTime: "asc",
      },
    });
    return NextResponse.json(reservations);
  } catch (error) {
    console.error("GET reservations error:", error);
    return NextResponse.json({ error: "Failed to fetch reservations" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { source, roomName, customerName, phone, startTime, endTime, price, headCount, coffeeCount, purpose, detail, paymentMethod, isPaid, memo, discount } = body;

    // Check if the same person (by name or phone) has a previous 'isCleanUpBad' record
    let autoCleanUpBad = false;
    if (customerName || phone) {
      const badRecord = await prisma.reservation.findFirst({
        where: {
          isCleanUpBad: true,
          OR: [
            ...(customerName ? [{ customerName: customerName }] : []),
            ...(phone ? [{ phone: phone }] : []),
          ]
        }
      });
      if (badRecord) {
        autoCleanUpBad = true;
      }
    }

    const reservation = await prisma.reservation.create({
      data: {
        source: source || "manual",
        roomName: roomName || "머무룸1",
        customerName: customerName || "미지정",
        phone: phone || null,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        price: Number(price) || 0,
        discount: Number(discount) || 0,
        paymentMethod: paymentMethod || "온라인",
        isPaid: isPaid !== undefined ? Boolean(isPaid) : true,
        isCleanUpBad: autoCleanUpBad,
        memo: memo || null,
        usageLog: {
          create: {
            headCount: Number(headCount) || 1,
            reservedHeadCount: Number(headCount) || 1, // 예약=실제 동일하게 시작
            coffeeCount: Number(coffeeCount) || 0,
            purpose: purpose || null,
            detail: detail || null,
          },
        },
      },
      include: {
        usageLog: true,
      },
    });

    return NextResponse.json(reservation, { status: 201 });
  } catch (error) {
    console.error("POST reservation error:", error);
    return NextResponse.json({ error: "Failed to create reservation" }, { status: 500 });
  }
}
