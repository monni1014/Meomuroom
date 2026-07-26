import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeCustomerType } from "@/lib/customer-types";
import { buildManualReservationPush } from "@/lib/manual-reservation-push";
import { sendPushNotification } from "@/lib/push-notifications";

export const dynamic = "force-dynamic";

const VALID_ROOM_NAMES = new Set(["머무룸1", "머무룸2", "머무룸3"]);

function parseReservationDate(value: unknown) {
  const date = typeof value === "string" || value instanceof Date ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

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
    const { source, roomName, customerName, customerType, phone, startTime, endTime, price, headCount, coffeeCount, purpose, detail, paymentMethod, isPaid, memo, discount, pushSubscriptionEndpoint } = body;

    if (!VALID_ROOM_NAMES.has(roomName)) {
      return NextResponse.json({ error: "A valid roomName is required" }, { status: 400 });
    }

    const parsedStartTime = parseReservationDate(startTime);
    const parsedEndTime = parseReservationDate(endTime);
    if (!parsedStartTime || !parsedEndTime) {
      return NextResponse.json({ error: "Valid startTime and endTime are required" }, { status: 400 });
    }
    if (parsedEndTime.getTime() <= parsedStartTime.getTime()) {
      return NextResponse.json({ error: "endTime must be later than startTime" }, { status: 400 });
    }

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
        roomName,
        customerName: customerName || "미지정",
        customerType: normalizeCustomerType(customerType),
        phone: phone || null,
        startTime: parsedStartTime,
        endTime: parsedEndTime,
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

    try {
      const excludedEndpoint = typeof pushSubscriptionEndpoint === "string"
        && pushSubscriptionEndpoint.startsWith("https://")
        ? pushSubscriptionEndpoint
        : null;
      const pushResult = await sendPushNotification(
        buildManualReservationPush(reservation),
        { excludeEndpoints: excludedEndpoint ? [excludedEndpoint] : [] },
      );
      console.info(
        `[ManualReservation] Push sent ${pushResult.sent}, failed ${pushResult.failed}, origin excluded ${Boolean(excludedEndpoint)}`,
      );
    } catch (pushError) {
      console.error("Manual reservation push failed:", pushError);
    }

    return NextResponse.json(reservation, { status: 201 });
  } catch (error) {
    console.error("POST reservation error:", error);
    return NextResponse.json({ error: "Failed to create reservation" }, { status: 500 });
  }
}
