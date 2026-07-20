import webpush from "web-push";
import { prisma } from "@/lib/prisma";

const SUBSCRIPTIONS_KEY = "webpush.subscriptions";

export type StoredPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  lastSeenAt: string;
};

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function isValidSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPushSubscription>;
  return Boolean(
    typeof candidate.endpoint === "string" &&
    candidate.endpoint.startsWith("https://") &&
    candidate.keys &&
    typeof candidate.keys.p256dh === "string" &&
    typeof candidate.keys.auth === "string",
  );
}

async function readSubscriptions() {
  const setting = await prisma.appSetting.findUnique({ where: { key: SUBSCRIPTIONS_KEY } });
  if (!setting) return [] as StoredPushSubscription[];
  try {
    const parsed = JSON.parse(setting.value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isValidSubscription) : [];
  } catch {
    return [] as StoredPushSubscription[];
  }
}

async function writeSubscriptions(subscriptions: StoredPushSubscription[]) {
  await prisma.appSetting.upsert({
    where: { key: SUBSCRIPTIONS_KEY },
    create: { key: SUBSCRIPTIONS_KEY, value: JSON.stringify(subscriptions) },
    update: { value: JSON.stringify(subscriptions) },
  });
}

export function getPushPublicKey() {
  return env("WEB_PUSH_VAPID_PUBLIC_KEY");
}

export function isPushConfigured() {
  return Boolean(
    getPushPublicKey() &&
    env("WEB_PUSH_VAPID_PRIVATE_KEY") &&
    env("WEB_PUSH_SUBJECT"),
  );
}

export async function getPushSubscriptionCount() {
  return (await readSubscriptions()).length;
}

export async function savePushSubscription(input: {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}) {
  if (!input.endpoint.startsWith("https://") || !input.keys.p256dh || !input.keys.auth) {
    throw new Error("Invalid push subscription.");
  }

  const now = new Date().toISOString();
  const subscriptions = await readSubscriptions();
  const existing = subscriptions.find((item) => item.endpoint === input.endpoint);
  const next: StoredPushSubscription = {
    endpoint: input.endpoint,
    expirationTime: input.expirationTime ?? null,
    keys: input.keys,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
  };
  await writeSubscriptions([
    ...subscriptions.filter((item) => item.endpoint !== input.endpoint),
    next,
  ]);
  return next;
}

export async function removePushSubscription(endpoint: string) {
  const subscriptions = await readSubscriptions();
  const next = subscriptions.filter((item) => item.endpoint !== endpoint);
  if (next.length !== subscriptions.length) await writeSubscriptions(next);
}

export async function sendPushNotification(payload: PushPayload) {
  if (!isPushConfigured()) return { configured: false, sent: 0, failed: 0 };

  const subscriptions = await readSubscriptions();
  if (subscriptions.length === 0) return { configured: true, sent: 0, failed: 0 };

  webpush.setVapidDetails(
    env("WEB_PUSH_SUBJECT"),
    getPushPublicKey(),
    env("WEB_PUSH_VAPID_PRIVATE_KEY"),
  );

  const invalidEndpoints = new Set<string>();
  let sent = 0;
  let failed = 0;

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: subscription.keys,
        },
        JSON.stringify(payload),
        { TTL: 60 * 60, urgency: "high" },
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) invalidEndpoints.add(subscription.endpoint);
      console.error("[WebPush] Delivery failed:", statusCode || error);
    }
  }));

  if (invalidEndpoints.size > 0) {
    await writeSubscriptions(subscriptions.filter((item) => !invalidEndpoints.has(item.endpoint)));
  }

  return { configured: true, sent, failed };
}
