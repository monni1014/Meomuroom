"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";

/**
 * 서버 컴포넌트(대시보드)를 주기적으로 새로고침해
 * 서버 cron이 받아온 새 예약/취소를 화면에 자동 반영한다.
 * 전체 페이지 리로드가 아니라 router.refresh()로 서버 데이터만 다시 가져온다.
 */
export default function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const refreshedOnMountRef = useRef(false);

  // 다른 화면에 머무는 동안 수기예약이 추가되면 미리 받아 둔 대시보드가
  // 잠깐 보일 수 있다. 대시보드 진입 시 한 번은 반드시 최신 서버 데이터로
  // 교체하고, 이후 변경분은 아래 폴링으로만 갱신한다.
  useEffect(() => {
    if (refreshedOnMountRef.current) return;
    refreshedOnMountRef.current = true;
    router.refresh();
  }, [router]);

  useDataChangePolling(
    "/api/data-version?scope=dashboard",
    () => router.refresh(),
    { intervalMs },
  );
  return null;
}
