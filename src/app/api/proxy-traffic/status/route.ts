import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function readNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function trafficSeverity(availableGb: number | null, warningGb: number, criticalGb: number) {
  if (availableGb === null) return "UNKNOWN";
  if (availableGb <= criticalGb) return "CRITICAL";
  if (availableGb <= warningGb) return "WARNING";
  return "OK";
}

export async function GET() {
  try {
    const latest = await prisma.proxyTrafficCheck.findFirst({
      where: { provider: "iproyal" },
      orderBy: { checkedAt: "desc" },
    });

    const activeAlert = await prisma.adminAlert.findFirst({
      where: { type: "IPROYAL_TRAFFIC", resolved: false },
      orderBy: { createdAt: "desc" },
    });

    const warningGb = latest?.warningGb ?? readNumberEnv("IPROYAL_TRAFFIC_WARNING_GB", 0.2);
    const criticalGb = latest?.criticalGb ?? readNumberEnv("IPROYAL_TRAFFIC_CRITICAL_GB", 0.05);
    const availableGb = latest?.availableGb ?? null;

    return NextResponse.json({
      configured: Boolean(process.env.IPROYAL_API_TOKEN),
      availableGb,
      warningGb,
      criticalGb,
      severity: activeAlert?.severity === "CRITICAL"
        ? "CRITICAL"
        : trafficSeverity(availableGb, warningGb, criticalGb),
      checkedAt: latest?.checkedAt ?? null,
      alertTitle: activeAlert?.title ?? null,
    });
  } catch (error) {
    console.error("Proxy traffic status API error:", error);
    return NextResponse.json({ error: "Failed to load proxy traffic status" }, { status: 500 });
  }
}
