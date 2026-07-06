import { createAdminAlert, resolveAdminAlertsByType } from "@/lib/admin-alerts";
import { prisma } from "@/lib/prisma";

const IPROYAL_ME_URL = "https://resi-api.iproyal.com/v1/me";

function readNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export interface IproyalTrafficStatus {
  configured: boolean;
  availableGb: number | null;
  warningGb: number;
  criticalGb: number;
  severity: "OK" | "WARNING" | "CRITICAL" | "ERROR" | "NOT_CONFIGURED";
  message: string;
}

export async function checkIproyalTraffic(): Promise<IproyalTrafficStatus> {
  const apiToken = process.env.IPROYAL_API_TOKEN;
  const warningGb = readNumberEnv("IPROYAL_TRAFFIC_WARNING_GB", 0.2);
  const criticalGb = readNumberEnv("IPROYAL_TRAFFIC_CRITICAL_GB", 0.05);

  if (!apiToken) {
    return {
      configured: false,
      availableGb: null,
      warningGb,
      criticalGb,
      severity: "NOT_CONFIGURED",
      message: "IPRoyal API token is not configured. Set IPROYAL_API_TOKEN in .env.",
    };
  }

  const response = await fetch(IPROYAL_ME_URL, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    cache: "no-store",
  });

  const rawPayload = await response.text();

  if (!response.ok) {
    return {
      configured: true,
      availableGb: null,
      warningGb,
      criticalGb,
      severity: "ERROR",
      message: `IPRoyal traffic check failed. status=${response.status}, body=${rawPayload.slice(0, 300)}`,
    };
  }

  const payload = JSON.parse(rawPayload) as { available_traffic?: number };
  const availableGb = Number(payload.available_traffic);

  if (!Number.isFinite(availableGb)) {
    return {
      configured: true,
      availableGb: null,
      warningGb,
      criticalGb,
      severity: "ERROR",
      message: `IPRoyal response did not include available_traffic. body=${rawPayload.slice(0, 300)}`,
    };
  }

  await prisma.proxyTrafficCheck.create({
    data: {
      provider: "iproyal",
      availableGb,
      warningGb,
      criticalGb,
      rawPayload,
    },
  });

  if (availableGb <= criticalGb) {
    return {
      configured: true,
      availableGb,
      warningGb,
      criticalGb,
      severity: "CRITICAL",
      message: `IPRoyal proxy traffic is almost empty: ${availableGb.toFixed(3)}GB remaining.`,
    };
  }

  if (availableGb <= warningGb) {
    return {
      configured: true,
      availableGb,
      warningGb,
      criticalGb,
      severity: "WARNING",
      message: `IPRoyal proxy traffic is low: ${availableGb.toFixed(3)}GB remaining.`,
    };
  }

  return {
    configured: true,
    availableGb,
    warningGb,
    criticalGb,
    severity: "OK",
    message: `IPRoyal proxy traffic remaining: ${availableGb.toFixed(3)}GB.`,
  };
}

export async function checkIproyalTrafficAndAlert() {
  const status = await checkIproyalTraffic();

  if (status.severity === "NOT_CONFIGURED") {
    await createAdminAlert({
      type: "IPROYAL_TRAFFIC",
      severity: "WARNING",
      title: "IPRoyal API token required",
      message: status.message,
      dedupeKey: "iproyal-traffic-not-configured",
    });
  } else if (status.severity === "CRITICAL") {
    await createAdminAlert({
      type: "IPROYAL_TRAFFIC",
      severity: "CRITICAL",
      title: "IPRoyal traffic almost empty",
      message: status.message,
      dedupeKey: "iproyal-traffic-critical",
    });
  } else if (status.severity === "WARNING") {
    await createAdminAlert({
      type: "IPROYAL_TRAFFIC",
      severity: "WARNING",
      title: "IPRoyal traffic low",
      message: status.message,
      dedupeKey: "iproyal-traffic-warning",
    });
  } else if (status.severity === "ERROR") {
    await createAdminAlert({
      type: "IPROYAL_TRAFFIC",
      severity: "WARNING",
      title: "IPRoyal traffic check failed",
      message: status.message,
      dedupeKey: "iproyal-traffic-check-error",
    });
  } else if (status.severity === "OK") {
    await resolveAdminAlertsByType("IPROYAL_TRAFFIC");
  }

  return status;
}
