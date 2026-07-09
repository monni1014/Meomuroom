import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeCustomerType } from "@/lib/customer-types";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { customerName, customerType, phone, startTime, endTime, price, paymentMethod, isPaid, memo, discount, headCount, reservedHeadCount, coffeeCount, purpose, detail, roomName, complaints, isCleanUpBad, extraPrice, isExtraPaid, extraPaymentMethod, extraTime, status, isNoShow } = body;

    // First check if reservation exists
    const existing = await prisma.reservation.findUnique({
      where: { id },
      include: { usageLog: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    }

    // Prepare update data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};
    if (customerName !== undefined) updateData.customerName = customerName;
    if (customerType !== undefined) updateData.customerType = normalizeCustomerType(customerType);
    if (phone !== undefined) updateData.phone = phone;
    if (startTime !== undefined) updateData.startTime = new Date(startTime);
    if (endTime !== undefined) updateData.endTime = new Date(endTime);
    if (price !== undefined) updateData.price = Number(price);
    if (discount !== undefined) updateData.discount = Number(discount);
    if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod;
    if (isPaid !== undefined) updateData.isPaid = Boolean(isPaid);
    if (memo !== undefined) updateData.memo = memo;
    if (complaints !== undefined) updateData.complaints = complaints;
    if (roomName !== undefined) updateData.roomName = roomName;
    if (isCleanUpBad !== undefined) updateData.isCleanUpBad = Boolean(isCleanUpBad);
    if (status !== undefined) updateData.status = status; // CONFIRMED ↔ CANCELLED (취소 되살리기 등)
    if (isNoShow !== undefined) updateData.isNoShow = Boolean(isNoShow); // 노쇼 표기 (취소의 하위 구분)

    const notificationRelevantChanged =
      customerName !== undefined ||
      phone !== undefined ||
      startTime !== undefined ||
      endTime !== undefined ||
      roomName !== undefined;
    const nextStartTime = startTime !== undefined ? new Date(startTime) : existing.startTime;
    const nextStatus = status !== undefined ? status : existing.status;

    if (notificationRelevantChanged && nextStatus === "CONFIRMED" && nextStartTime.getTime() > Date.now()) {
      updateData.notified = false;
      updateData.notifiedAt = null;
      updateData.notificationStatus = "PENDING";
      updateData.notificationChannel = null;
      updateData.notificationError = null;
    }

    // Prepare usage data update
    if (headCount !== undefined || reservedHeadCount !== undefined || coffeeCount !== undefined || purpose !== undefined || detail !== undefined || extraPrice !== undefined || isExtraPaid !== undefined || extraPaymentMethod !== undefined || extraTime !== undefined) {
      if (existing.usageLog) {
        updateData.usageLog = {
          update: {
            headCount: headCount !== undefined ? Number(headCount) : undefined,
            reservedHeadCount: reservedHeadCount !== undefined ? Number(reservedHeadCount) : undefined,
            coffeeCount: coffeeCount !== undefined ? Number(coffeeCount) : undefined,
            purpose: purpose !== undefined ? purpose : undefined,
            detail: detail !== undefined ? detail : undefined,
            extraPrice: extraPrice !== undefined ? Number(extraPrice) : undefined,
            isExtraPaid: isExtraPaid !== undefined ? Boolean(isExtraPaid) : undefined,
            extraPaymentMethod: extraPaymentMethod !== undefined ? extraPaymentMethod : undefined,
            extraTime: extraTime !== undefined ? Number(extraTime) : undefined,
          },
        };
      } else {
        updateData.usageLog = {
          create: {
            headCount: headCount !== undefined ? Number(headCount) : 1,
            reservedHeadCount: reservedHeadCount !== undefined ? Number(reservedHeadCount) : (headCount !== undefined ? Number(headCount) : 1),
            coffeeCount: coffeeCount !== undefined ? Number(coffeeCount) : 0,
            purpose: purpose !== undefined ? purpose : null,
            detail: detail !== undefined ? detail : null,
            extraPrice: extraPrice !== undefined ? Number(extraPrice) : null,
            isExtraPaid: isExtraPaid !== undefined ? Boolean(isExtraPaid) : false,
            extraPaymentMethod: extraPaymentMethod !== undefined ? extraPaymentMethod : null,
            extraTime: extraTime !== undefined ? Number(extraTime) : 0,
          },
        };
      }
    }

    const updated = await prisma.reservation.update({
      where: { id },
      data: updateData,
      include: {
        usageLog: true,
      },
    });

    // Sync isCleanUpBad across all reservations for this customer (if name is valid)
    if (isCleanUpBad !== undefined && updated.customerName && updated.customerName !== "미지정") {
      await prisma.reservation.updateMany({
        where: { customerName: updated.customerName },
        data: { isCleanUpBad: Boolean(isCleanUpBad) },
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PATCH reservation error:", error);
    return NextResponse.json({ error: "Failed to update reservation" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;

    // Delete associated details first. We can do this with transact or clean up
    await prisma.usageLog.deleteMany({
      where: { reservationId: id },
    });

    const deleted = await prisma.reservation.delete({
      where: { id },
    });

    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("DELETE reservation error:", error);
    return NextResponse.json({ error: "Failed to delete reservation" }, { status: 500 });
  }
}
