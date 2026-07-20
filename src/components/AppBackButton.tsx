"use client";

import { ArrowLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

export function AppBackButton() {
  const pathname = usePathname();
  const router = useRouter();
  const isDashboard = pathname === "/";

  function handleBack() {
    if (isDashboard) return;

    if (window.history.length > 1) {
      router.back();
      return;
    }

    router.replace("/");
  }

  return (
    <div className="sticky top-0 z-40 flex h-12 items-center border-b border-slate-200 bg-white/95 px-3 shadow-sm backdrop-blur md:px-6">
      <button
        type="button"
        onClick={handleBack}
        disabled={isDashboard}
        aria-label="이전 화면으로 돌아가기"
        title={isDashboard ? "대시보드입니다" : "이전 화면으로 돌아가기"}
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 disabled:cursor-default disabled:text-slate-300 disabled:hover:bg-transparent"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>뒤로</span>
      </button>
    </div>
  );
}
