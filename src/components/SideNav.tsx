"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Calendar, Home, ClipboardList, BarChart3, Building2, Table2, Radar, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { name: "대시보드", href: "/", icon: Home },
  { name: "캘린더", href: "/calendar", icon: Calendar },
  { name: "월간표", href: "/monthly-table", icon: Table2 },
  { name: "이용현황", href: "/usage", icon: ClipboardList },
  { name: "경쟁사", href: "/competitors", icon: Radar },
  { name: "통계", href: "/analytics", icon: BarChart3 },
];

interface ProxyTrafficStatus {
  configured: boolean;
  availableGb: number | null;
  severity: "OK" | "WARNING" | "CRITICAL" | "UNKNOWN";
  checkedAt: string | null;
  alertTitle: string | null;
}

function proxyStatusClass(severity: ProxyTrafficStatus["severity"], configured: boolean) {
  if (!configured || severity === "UNKNOWN") return "border-slate-200 bg-slate-50 text-slate-500";
  if (severity === "CRITICAL") return "border-rose-200 bg-rose-50 text-rose-700";
  if (severity === "WARNING") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function proxyStatusLabel(status: ProxyTrafficStatus | null) {
  if (!status) return "확인중";
  if (!status.configured) return "토큰 필요";
  if (status.availableGb === null) return "확인필요";
  return `${status.availableGb.toFixed(2)}GB`;
}

function ProxyTrafficPanel() {
  const [status, setStatus] = useState<ProxyTrafficStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const response = await fetch("/api/proxy-traffic/status", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as ProxyTrafficStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };

    loadStatus();
    const interval = window.setInterval(loadStatus, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const configured = status?.configured ?? true;
  const severity = status?.severity ?? "UNKNOWN";

  return (
    <div className={cn("hidden md:block mt-auto px-1 pb-2")}>
      <div className={cn("rounded-xl border px-3 py-3", proxyStatusClass(severity, configured))}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Wifi className="h-4 w-4 flex-shrink-0" />
            <span className="text-xs font-bold text-slate-500">IPRoyal</span>
          </div>
          <span className="text-sm font-black tabular-nums">{proxyStatusLabel(status)}</span>
        </div>
        <p className="mt-1 truncate text-[11px] font-semibold opacity-80">
          {status?.alertTitle || (status?.configured === false ? "API token required" : "프록시 잔여량")}
        </p>
      </div>
    </div>
  );
}

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "fixed z-50 bg-white border-slate-200 flex",
        // 모바일: 하단 탭바 (가로)
        "bottom-0 left-0 right-0 h-16 border-t flex-row",
        // 데스크톱(md+): 좌측 사이드바 (세로)
        "md:top-0 md:right-auto md:h-full md:w-64 md:border-t-0 md:border-r md:flex-col"
      )}
    >
      {/* 로고 헤더 — 데스크톱 사이드바에서만 표시 */}
      <div className="hidden md:flex items-center h-16 px-6 border-b border-slate-100">
        <div className="flex items-center gap-3 text-indigo-600">
          <Building2 className="w-8 h-8" />
          <span className="font-bold text-xl text-slate-900 tracking-tight">머무룸 DX</span>
        </div>
      </div>

      <div className="flex-1 flex flex-row md:flex-col justify-around md:justify-start md:py-6 md:px-3 md:gap-2">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 md:flex-none flex-col md:flex-row items-center md:justify-start gap-1 md:gap-4 px-1 md:px-3 py-2 md:py-3 md:rounded-xl transition-all duration-200 group",
                isActive
                  ? "text-indigo-700 md:bg-indigo-50"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <item.icon
                className={cn(
                  "w-6 h-6 flex-shrink-0 transition-colors duration-200",
                  isActive ? "text-indigo-600" : "text-slate-400 group-hover:text-slate-600"
                )}
                strokeWidth={isActive ? 2.5 : 2}
              />
              <span className={cn(
                "text-[10px] md:text-sm",
                isActive ? "font-semibold" : "font-medium"
              )}>
                {item.name}
              </span>
            </Link>
          );
        })}
        <ProxyTrafficPanel />
      </div>
    </nav>
  );
}
