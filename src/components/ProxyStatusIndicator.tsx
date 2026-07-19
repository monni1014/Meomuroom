"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { IspProxyStatus } from "@/lib/proxy-status-types";
import { cn } from "@/lib/utils";

const REFRESH_MS = 10 * 60 * 1000;

function unavailableStatus(): IspProxyStatus {
  return {
    provider: "Proxy-Seller",
    configured: false,
    apiConfigured: false,
    endpointConfigured: false,
    apiOk: false,
    connectionOk: false,
    severity: "ERROR",
    summary: "프록시 상태 확인 실패",
    orderStatus: null,
    country: null,
    expiresOn: null,
    daysRemaining: null,
    autoRenew: null,
    autoRenewPeriod: null,
    expectedIp: null,
    detectedIp: null,
    ipMatches: null,
    detectedCountry: null,
    detectedOrganization: null,
    checkedAt: new Date().toISOString(),
    error: "상태 조회 요청에 실패했습니다.",
  };
}

function dotClass(severity: IspProxyStatus["severity"] | "LOADING") {
  if (severity === "OK") return "bg-emerald-500";
  if (severity === "WARNING") return "bg-amber-500";
  if (severity === "ERROR") return "bg-rose-500";
  return "bg-slate-300";
}

function formatExpiry(status: IspProxyStatus | null) {
  if (!status?.expiresOn) return "만료일 확인 중";
  const [year, month, day] = status.expiresOn.split("-");
  if (!year || !month || !day) return `만료 ${status.expiresOn}`;
  return `${Number(month)}월 ${Number(day)}일 만료`;
}

export function ProxyStatusIndicator() {
  const [status, setStatus] = useState<IspProxyStatus | null>(null);

  useEffect(() => {
    let active = true;

    const loadStatus = async () => {
      try {
        const response = await fetch("/api/proxy/status", { cache: "no-store" });
        if (!response.ok) throw new Error("status request failed");
        const nextStatus = await response.json() as IspProxyStatus;
        if (active) setStatus(nextStatus);
      } catch {
        if (active) {
          setStatus((current) => current ? {
            ...current,
            severity: "ERROR",
            summary: "프록시 상태 확인 실패",
          } : unavailableStatus());
        }
      }
    };

    const initialTimer = window.setTimeout(() => void loadStatus(), 0);
    const refreshTimer = window.setInterval(() => void loadStatus(), REFRESH_MS);
    return () => {
      active = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, []);

  return (
    <div className="hidden border-t border-slate-100 p-3 md:block">
      <Link
        href="/settings"
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-600 transition hover:bg-slate-50"
        title="설정에서 ISP 프록시 상태 확인"
      >
        <div className="relative shrink-0">
          <ShieldCheck className="h-5 w-5 text-slate-400" />
          <span className={cn(
            "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white",
            dotClass(status?.severity || "LOADING"),
          )} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-black text-slate-700">
            {status?.summary || "ISP 프록시 확인 중"}
          </p>
          <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">
            {formatExpiry(status)}
          </p>
        </div>
      </Link>
    </div>
  );
}
