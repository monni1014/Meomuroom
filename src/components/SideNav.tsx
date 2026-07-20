"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, Home, ClipboardList, BarChart3, Building2, Table2, Radar, Settings, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProxyStatusIndicator } from "@/components/ProxyStatusIndicator";

const NAV_ITEMS = [
  { name: "대시보드", href: "/", icon: Home },
  { name: "캘린더", href: "/calendar", icon: Calendar },
  { name: "문자 현황", href: "/messages", icon: MessageSquareText },
  { name: "이용현황", href: "/usage", icon: ClipboardList },
  { name: "월간표", href: "/monthly-table", icon: Table2 },
  { name: "경쟁사 현황", href: "/competitors", icon: Radar },
  { name: "통계", href: "/analytics", icon: BarChart3 },
  { name: "설정", href: "/settings", icon: Settings },
];

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
                "relative flex flex-1 md:flex-none flex-col md:flex-row items-center md:justify-start gap-1 md:gap-4 px-1 md:px-3 py-2 md:py-3 md:rounded-xl transition-all duration-200 group",
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
                "whitespace-nowrap text-[9px] sm:text-[10px] md:text-sm",
                isActive ? "font-semibold" : "font-medium"
              )}>
                {item.name}
              </span>
            </Link>
          );
        })}
      </div>
      <ProxyStatusIndicator />
    </nav>
  );
}
