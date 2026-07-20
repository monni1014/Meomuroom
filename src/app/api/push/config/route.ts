import { NextResponse } from "next/server";
import {
  getPushPublicKey,
  getPushSubscriptionCount,
  isPushConfigured,
} from "@/lib/push-notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: getPushPublicKey() || null,
    subscriptionCount: await getPushSubscriptionCount(),
  }, { headers: { "Cache-Control": "no-store" } });
}
