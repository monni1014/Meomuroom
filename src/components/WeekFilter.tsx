"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { format, addWeeks, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";

export default function WeekFilter({ currentWeekStart }: { currentWeekStart: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleSelect = (startStr: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("weekStart", startStr);
    router.push(`/?${params.toString()}`, { scroll: false });
  };

  const options = [];
  const today = new Date();
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  
  // 첫 번째 주: 해당 월의 1일이 포함된 주 (월요일 시작)
  let current = startOfWeek(monthStart, { weekStartsOn: 1 });
  let weekNum = 1;

  while (current <= monthEnd) {
    const sRaw = current;
    const eRaw = endOfWeek(current, { weekStartsOn: 1 });
    
    const s = sRaw < monthStart ? monthStart : sRaw;
    const e = eRaw > monthEnd ? monthEnd : eRaw;
    
    // 만약 주차의 목요일이 이전 달이라면 해당 월의 1주차로 치지 않는 표준도 있지만,
    // 직관적으로 1일이 포함된 주를 1주차로 표기합니다.
    const label = `${weekNum}주차 (${format(s, "M/d")} ~ ${format(e, "M/d")})`;
    options.push({ value: format(current, "yyyy-MM-dd"), label });
    
    current = addWeeks(current, 1);
    weekNum++;
  }

  return (
    <select
      value={currentWeekStart}
      onChange={(e) => handleSelect(e.target.value)}
      className="text-sm border-none bg-transparent font-medium text-slate-600 outline-none cursor-pointer hover:text-indigo-600 transition"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
