import SettingsView from "./SettingsView";
import { getSolapiServiceStatus } from "@/lib/solapi-status";
import { getMessageTemplates } from "@/lib/message-templates";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function readNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

type ProxySeverity = "OK" | "WARNING" | "CRITICAL" | "UNKNOWN";

function trafficSeverity(availableGb: number | null, warningGb: number, criticalGb: number): ProxySeverity {
  if (availableGb === null) return "UNKNOWN";
  if (availableGb <= criticalGb) return "CRITICAL";
  if (availableGb <= warningGb) return "WARNING";
  return "OK";
}

async function getProxyStatus() {
  const latest = await prisma.proxyTrafficCheck.findFirst({
    where: { provider: "iproyal" },
    orderBy: { checkedAt: "desc" },
  });

  const activeAlert = await prisma.adminAlert.findFirst({
    where: { type: "IPROYAL_TRAFFIC", resolved: false, dismissedAt: null },
    orderBy: { createdAt: "desc" },
  });

  const warningGb = latest?.warningGb ?? readNumberEnv("IPROYAL_TRAFFIC_WARNING_GB", 0.2);
  const criticalGb = latest?.criticalGb ?? readNumberEnv("IPROYAL_TRAFFIC_CRITICAL_GB", 0.05);
  const availableGb = latest?.availableGb ?? null;

  return {
    configured: Boolean(process.env.IPROYAL_API_TOKEN),
    availableGb,
    warningGb,
    criticalGb,
    severity: (activeAlert?.severity === "CRITICAL"
      ? "CRITICAL"
      : trafficSeverity(availableGb, warningGb, criticalGb)) as ProxySeverity,
    checkedAt: latest?.checkedAt?.toISOString() ?? null,
    alertTitle: activeAlert?.title ?? null,
  };
}

export default async function SettingsPage() {
  const [solapiStatus, messageTemplates, proxyStatus] = await Promise.all([
    getSolapiServiceStatus(),
    getMessageTemplates(),
    getProxyStatus(),
  ]);

  return (
    <SettingsView
      initialSolapiStatus={solapiStatus}
      initialMessageTemplates={messageTemplates.map((template) => ({
        id: template.id,
        roomName: template.roomName,
        title: template.title,
        content: template.content,
        updatedAt: template.updatedAt.toISOString(),
      }))}
      initialProxyStatus={proxyStatus}
    />
  );
}
