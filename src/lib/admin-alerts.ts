import { prisma } from "@/lib/prisma";
import { shouldSendAdminAlertPush } from "@/lib/admin-alert-push-policy";
import { sendPushNotification } from "@/lib/push-notifications";

export interface AdminAlertInput {
  type: string;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  dedupeKey?: string;
  repeatAfterMs?: number;
}

async function sendWebhookAlert(input: AdminAlertInput) {
  const url = process.env.ADMIN_ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: input.type,
        severity: input.severity || "WARNING",
        title: input.title,
        message: input.message,
      }),
    });
  } catch (error) {
    console.error("[AdminAlert] Webhook delivery failed:", error);
  }
}

async function sendAppPushAlert(
  input: AdminAlertInput,
  alertId: string,
  severity: NonNullable<AdminAlertInput["severity"]>,
) {
  if (!shouldSendAdminAlertPush(input.type, severity)) return;

  try {
    await sendPushNotification({
      title: input.title,
      body: input.message.slice(0, 300),
      url: "/",
      tag: `admin-alert-${input.dedupeKey || alertId}`,
    });
  } catch (error) {
    console.error("[AdminAlert] App push delivery failed:", error);
  }
}

export async function createAdminAlert(input: AdminAlertInput) {
  const severity = input.severity || "WARNING";

  if (input.dedupeKey) {
    const existing = await prisma.adminAlert.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });

    if (existing && !existing.resolved) {
      const repeatAfterMs = input.repeatAfterMs;
      const shouldRepeat = typeof repeatAfterMs === "number"
        && repeatAfterMs > 0
        && Date.now() - existing.updatedAt.getTime() >= repeatAfterMs;
      if (!shouldRepeat) return existing;
    }
  }

  const alert = input.dedupeKey
    ? await prisma.adminAlert.upsert({
        where: { dedupeKey: input.dedupeKey },
        create: {
          type: input.type,
          severity,
          title: input.title,
          message: input.message,
          dedupeKey: input.dedupeKey,
        },
        update: {
          type: input.type,
          severity,
          title: input.title,
          message: input.message,
          resolved: false,
          dismissedAt: null,
        },
      })
    : await prisma.adminAlert.create({
        data: {
          type: input.type,
          severity,
          title: input.title,
          message: input.message,
        },
      });

  await Promise.all([
    sendWebhookAlert(input),
    sendAppPushAlert(input, alert.id, severity),
  ]);
  return alert;
}

export async function resolveAdminAlertsByType(type: string) {
  await prisma.adminAlert.updateMany({
    where: { type, resolved: false },
    data: { resolved: true },
  });
}

export async function resolveAdminAlertByDedupeKey(dedupeKey: string) {
  await prisma.adminAlert.updateMany({
    where: { dedupeKey, resolved: false },
    data: { resolved: true },
  });
}
