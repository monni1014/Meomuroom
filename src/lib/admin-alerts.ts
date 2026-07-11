import { prisma } from "@/lib/prisma";

export interface AdminAlertInput {
  type: string;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  dedupeKey?: string;
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

export async function createAdminAlert(input: AdminAlertInput) {
  const severity = input.severity || "WARNING";

  if (input.dedupeKey) {
    const existing = await prisma.adminAlert.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });

    if (existing && !existing.resolved) return existing;
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

  await sendWebhookAlert(input);
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
