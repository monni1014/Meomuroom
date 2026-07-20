import { NextRequest, NextResponse } from "next/server";
import { removePushSubscription, savePushSubscription } from "@/lib/push-notifications";

export const dynamic = "force-dynamic";

type SubscriptionBody = {
  endpoint?: unknown;
  expirationTime?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

function parseSubscription(body: SubscriptionBody) {
  if (
    typeof body.endpoint !== "string" ||
    !body.endpoint.startsWith("https://") ||
    !body.keys ||
    typeof body.keys.p256dh !== "string" ||
    typeof body.keys.auth !== "string"
  ) return null;

  return {
    endpoint: body.endpoint,
    expirationTime: typeof body.expirationTime === "number" ? body.expirationTime : null,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SubscriptionBody;
    const subscription = parseSubscription(body);
    if (!subscription) {
      return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
    }
    await savePushSubscription(subscription);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST push subscription error:", error);
    return NextResponse.json({ error: "Failed to save push subscription" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json() as { endpoint?: unknown };
    if (typeof body.endpoint !== "string") {
      return NextResponse.json({ error: "Endpoint is required" }, { status: 400 });
    }
    await removePushSubscription(body.endpoint);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE push subscription error:", error);
    return NextResponse.json({ error: "Failed to remove push subscription" }, { status: 500 });
  }
}
