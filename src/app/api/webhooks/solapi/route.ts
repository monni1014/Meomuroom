import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { processSolapiReport, type SolapiReport } from "@/lib/solapi-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 600_000;

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySecret(received: string | null) {
  const secret = env("SOLAPI_WEBHOOK_SECRET");
  if (!secret || !received) return false;
  const expected = createHash("sha1").update(secret).digest("hex");
  return secureEqual(received.trim().toLowerCase(), expected);
}

export async function POST(request: NextRequest) {
  if (!env("SOLAPI_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  }
  if (!verifySecret(request.headers.get("x-solapi-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventName = request.headers.get("x-solapi-event-name");
  if (eventName && eventName !== "SINGLE-REPORT") {
    return NextResponse.json({ error: "Unsupported event" }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    const parsed = JSON.parse(rawBody) as SolapiReport | SolapiReport[];
    const reports = Array.isArray(parsed) ? parsed : [parsed];
    const results = await Promise.all(reports.map((report) => processSolapiReport(report)));
    return NextResponse.json({
      success: true,
      received: reports.length,
      processed: results.filter((result) => result.processed).length,
      ignored: results.filter((result) => !result.processed).length,
    });
  } catch (error) {
    console.error("Solapi webhook processing error:", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
