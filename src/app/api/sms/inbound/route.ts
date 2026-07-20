import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  findReservationForCustomerPhone,
  hashSmsBridgeToken,
} from "@/lib/customer-messages";
import { normalizeKoreanPhone } from "@/lib/phone-number";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 12_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOccurredAt(value: unknown) {
  const parsed = new Date(asString(value));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function POST(request: NextRequest) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_WEBHOOK_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const token = request.nextUrl.searchParams.get("token")?.trim() || "";
    if (token.length < 32) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const device = await prisma.smsBridgeDevice.findUnique({
      where: { tokenHash: hashSmsBridgeToken(token) },
    });
    if (!device?.enabled) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    let body: JsonObject;
    try {
      body = asObject(JSON.parse(rawBody));
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (asString(body.event) !== "sms:received") {
      return NextResponse.json(
        { accepted: true, stored: false, reason: "unsupported_event" },
        { headers: NO_STORE_HEADERS },
      );
    }

    const externalDeviceId = asString(body.deviceId);
    if (
      device.externalDeviceId &&
      externalDeviceId &&
      device.externalDeviceId !== externalDeviceId
    ) {
      return NextResponse.json({ error: "Device identity mismatch" }, { status: 403 });
    }

    const payload = asObject(body.payload);
    const messageBody = asString(payload.message || body.message);
    const senderNumber = normalizeKoreanPhone(
      asString(payload.sender || payload.phoneNumber || body.sender),
    );
    if (!messageBody || senderNumber.length < 9) {
      return NextResponse.json({ error: "Invalid SMS payload" }, { status: 400 });
    }

    const reservation = await findReservationForCustomerPhone(senderNumber);
    const now = new Date();
    await prisma.smsBridgeDevice.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        ...(!device.externalDeviceId && externalDeviceId ? { externalDeviceId } : {}),
      },
    });

    // Business reservation contacts only. Personal messages and authentication
    // codes are acknowledged but their body is never stored.
    if (!reservation) {
      return NextResponse.json(
        { accepted: true, stored: false, reason: "not_a_reservation_contact" },
        { headers: NO_STORE_HEADERS },
      );
    }

    const eventId =
      asString(body.id) ||
      asString(payload.messageId) ||
      hashSmsBridgeToken(`${senderNumber}\n${messageBody}\n${asString(payload.receivedAt)}`);
    const dedupeKey = `sms-bridge:${device.id}:${eventId}`;
    const existing = await prisma.customerMessage.findUnique({ where: { dedupeKey } });
    if (existing) {
      return NextResponse.json(
        { accepted: true, stored: true, duplicate: true, messageId: existing.id },
        { headers: NO_STORE_HEADERS },
      );
    }

    const message = await prisma.customerMessage.create({
      data: {
        direction: "INBOUND",
        channel: "SMS",
        status: "RECEIVED",
        senderNumber,
        recipientNumber: normalizeKoreanPhone(device.phoneNumber),
        customerPhone: senderNumber,
        body: messageBody,
        providerMessageId: asString(payload.messageId) || null,
        dedupeKey,
        reservationId: reservation.id,
        bridgeDeviceId: device.id,
        occurredAt: parseOccurredAt(payload.receivedAt),
      },
    });

    return NextResponse.json(
      { accepted: true, stored: true, messageId: message.id },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("SMS bridge inbound webhook error:", error);
    return NextResponse.json(
      { error: "Failed to process inbound SMS" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
