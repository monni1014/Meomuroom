import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeCustomerType } from "@/lib/customer-types";
import { reservationNotificationEditPolicy } from "@/lib/reservation-notification-edit-policy";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { shouldLockManuallyEditedPhone } from "@/lib/reservation-phone-lock";
import { shouldLockManuallyEditedTime } from "@/lib/reservation-time-lock";
import { hasNewlyCompletedReview, validateReviewProgress } from "@/lib/review-event-policy";
import {
  getReviewRefundAccountMessageReadiness,
  sendReviewRefundAccountRequest,
} from "@/lib/review-refund-account-notifications";

const VALID_ROOM_NAMES = new Set(["머무룸1", "머무룸2", "머무룸3"]);

function parseReservationDate(value: unknown) {
  const date = typeof value === "string" || value instanceof Date ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { source, customerName, customerType, phone, startTime, endTime, price, paymentMethod, isPaid, memo, discount, headCount, reservedHeadCount, coffeeCount, purpose, detail, roomName, complaints, isCleanUpBad, visitorReviewRequested, visitorReviewCompleted, visitorReviewRefunded, blogReviewRequested, blogReviewCompleted, blogReviewRefunded, extraPrice, isExtraPaid, extraPaymentMethod, extraTime, status, isNoShow, resendNotification } = body;

    if (typeof phone === "string" && phone.trim() && !isValidKoreanMobilePhone(phone)) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }

    if (roomName !== undefined && !VALID_ROOM_NAMES.has(roomName)) {
      return NextResponse.json({ error: "Invalid roomName" }, { status: 400 });
    }

    // First check if reservation exists
    const existing = await prisma.reservation.findUnique({
      where: { id },
      include: { usageLog: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    }

    const nextVisitorReviewRequested = visitorReviewRequested !== undefined
      ? Boolean(visitorReviewRequested)
      : existing.visitorReviewRequested;
    const nextVisitorReviewCompleted = visitorReviewCompleted !== undefined
      ? Boolean(visitorReviewCompleted)
      : existing.visitorReviewCompleted;
    const nextVisitorReviewRefunded = visitorReviewRefunded !== undefined
      ? Boolean(visitorReviewRefunded)
      : existing.visitorReviewRefunded;
    const nextBlogReviewRequested = blogReviewRequested !== undefined
      ? Boolean(blogReviewRequested)
      : existing.blogReviewRequested;
    const nextBlogReviewCompleted = blogReviewCompleted !== undefined
      ? Boolean(blogReviewCompleted)
      : existing.blogReviewCompleted;
    const nextBlogReviewRefunded = blogReviewRefunded !== undefined
      ? Boolean(blogReviewRefunded)
      : existing.blogReviewRefunded;

    const reviewProgressError = validateReviewProgress({
      visitorReviewRequested: nextVisitorReviewRequested,
      visitorReviewCompleted: nextVisitorReviewCompleted,
      visitorReviewRefunded: nextVisitorReviewRefunded,
      blogReviewRequested: nextBlogReviewRequested,
      blogReviewCompleted: nextBlogReviewCompleted,
      blogReviewRefunded: nextBlogReviewRefunded,
    });
    if (reviewProgressError) {
      return NextResponse.json({
        error: reviewProgressError,
        code: "INVALID_REVIEW_PROGRESS",
      }, { status: 400 });
    }

    const shouldSendReviewRefundAccountRequest = hasNewlyCompletedReview(
      {
        visitorReviewCompleted: existing.visitorReviewCompleted,
        blogReviewCompleted: existing.blogReviewCompleted,
      },
      {
        visitorReviewCompleted: nextVisitorReviewCompleted,
        blogReviewCompleted: nextBlogReviewCompleted,
      },
    );
    if (shouldSendReviewRefundAccountRequest) {
      const readiness = await getReviewRefundAccountMessageReadiness(
        typeof phone === "string" ? phone : existing.phone,
      );
      if (!readiness.ready) {
        return NextResponse.json({
          error: readiness.error,
          code: "REVIEW_REFUND_ACCOUNT_MESSAGE_NOT_READY",
        }, { status: 400 });
      }
    }

    if (nextBlogReviewRefunded && !existing.blogReviewRefunded) {
      const nextPhone = normalizeKoreanPhone(typeof phone === "string" ? phone : existing.phone);
      if (nextPhone) {
        const previousBlogRefunds = await prisma.reservation.findMany({
          where: {
            id: { not: existing.id },
            blogReviewRefunded: true,
            phone: { not: null },
          },
          select: { id: true, customerName: true, startTime: true, phone: true },
          orderBy: { startTime: "desc" },
        });
        const previousBlogRefund = previousBlogRefunds.find(
          (reservation) => normalizeKoreanPhone(reservation.phone) === nextPhone,
        );
        if (previousBlogRefund) {
          return NextResponse.json({
            error: "이 전화번호는 블로그 리뷰 환급 이력이 있습니다. 블로그 리뷰는 고객당 1회만 환급할 수 있습니다.",
            code: "BLOG_REVIEW_ALREADY_REFUNDED",
            previousReservation: previousBlogRefund,
          }, { status: 409 });
        }
      }
    }

    const parsedStartTime = startTime !== undefined ? parseReservationDate(startTime) : existing.startTime;
    const parsedEndTime = endTime !== undefined ? parseReservationDate(endTime) : existing.endTime;
    if (!parsedStartTime || !parsedEndTime) {
      return NextResponse.json({ error: "Invalid startTime or endTime" }, { status: 400 });
    }
    if (parsedEndTime.getTime() <= parsedStartTime.getTime()) {
      return NextResponse.json({ error: "endTime must be later than startTime" }, { status: 400 });
    }

    // Prepare update data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};
    if (source !== undefined) updateData.source = source;
    if (customerName !== undefined) updateData.customerName = customerName;
    if (customerType !== undefined) updateData.customerType = normalizeCustomerType(customerType);
    if (phone !== undefined) updateData.phone = phone;
    if (startTime !== undefined) updateData.startTime = parsedStartTime;
    if (endTime !== undefined) updateData.endTime = parsedEndTime;
    if (price !== undefined) updateData.price = Number(price);
    if (discount !== undefined) updateData.discount = Number(discount);
    if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod;
    if (isPaid !== undefined) updateData.isPaid = Boolean(isPaid);
    if (memo !== undefined) updateData.memo = memo;
    if (complaints !== undefined) updateData.complaints = complaints;
    if (roomName !== undefined) updateData.roomName = roomName;
    if (isCleanUpBad !== undefined) updateData.isCleanUpBad = Boolean(isCleanUpBad);
    if (visitorReviewRequested !== undefined) updateData.visitorReviewRequested = Boolean(visitorReviewRequested);
    if (visitorReviewCompleted !== undefined) updateData.visitorReviewCompleted = Boolean(visitorReviewCompleted);
    if (visitorReviewRefunded !== undefined) updateData.visitorReviewRefunded = Boolean(visitorReviewRefunded);
    if (blogReviewRequested !== undefined) updateData.blogReviewRequested = Boolean(blogReviewRequested);
    if (blogReviewCompleted !== undefined) updateData.blogReviewCompleted = Boolean(blogReviewCompleted);
    if (blogReviewRefunded !== undefined) updateData.blogReviewRefunded = Boolean(blogReviewRefunded);
    if (status !== undefined) updateData.status = status; // CONFIRMED ↔ CANCELLED (취소 되살리기 등)
    if (isNoShow !== undefined) updateData.isNoShow = Boolean(isNoShow); // 노쇼 표기 (취소의 하위 구분)

    const nextStartTime = parsedStartTime;
    const nextStatus = status !== undefined ? status : existing.status;
    const notificationEditPolicy = reservationNotificationEditPolicy({
      existing: {
        phone: existing.phone,
        startTime: existing.startTime,
        endTime: existing.endTime,
        roomName: existing.roomName,
        status: existing.status,
        notified: existing.notified,
        notificationStatus: existing.notificationStatus,
      },
      next: {
        phone: phone !== undefined ? (typeof phone === "string" ? phone : null) : existing.phone,
        startTime: parsedStartTime,
        endTime: parsedEndTime,
        roomName: roomName !== undefined ? roomName : existing.roomName,
        status: nextStatus,
        notified: existing.notified,
        notificationStatus: existing.notificationStatus,
      },
    });

    if (notificationEditPolicy.requiresConfirmation && typeof resendNotification !== "boolean") {
      return NextResponse.json({
        error: "안내문자 재발송 여부를 확인해 주세요.",
        code: "NOTIFICATION_RESEND_CONFIRMATION_REQUIRED",
        changedFields: notificationEditPolicy.changedFields,
      }, { status: 409 });
    }

    const shouldResetNotification =
      notificationEditPolicy.shouldResetAutomatically ||
      (notificationEditPolicy.requiresConfirmation && resendNotification === true);

    if (notificationEditPolicy.changedFields.includes("phone")) {
      const nextSource = source !== undefined ? source : existing.source;
      updateData.phoneLocked = ["naver", "spacecloud"].includes(nextSource)
        && shouldLockManuallyEditedPhone(existing, typeof phone === "string" ? phone : null);
    }

    if (notificationEditPolicy.changedFields.some((field) => field === "startTime" || field === "endTime")) {
      const nextSource = source !== undefined ? source : existing.source;
      const isRpaSource = ["naver", "spacecloud"].includes(nextSource);
      updateData.timeLocked = isRpaSource
        && shouldLockManuallyEditedTime(existing, parsedStartTime, parsedEndTime);

      // Legacy rows do not have the original site range yet. Preserve the
      // range that was present immediately before the first manual edit so
      // restoring that exact range automatically releases the lock.
      if (isRpaSource && (!existing.syncedStartTime || !existing.syncedEndTime)) {
        updateData.syncedStartTime = existing.startTime;
        updateData.syncedEndTime = existing.endTime;
      }
    }

    if (shouldResetNotification && nextStatus === "CONFIRMED" && nextStartTime.getTime() > Date.now()) {
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

    const reviewRefundAccountMessage = shouldSendReviewRefundAccountRequest
      ? await sendReviewRefundAccountRequest(updated.id)
      : null;

    return NextResponse.json({ ...updated, reviewRefundAccountMessage });
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
