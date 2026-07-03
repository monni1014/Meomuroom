"use client";

import { useRouter, useSearchParams } from "next/navigation";

type MonthOption = {
  value: string;
  label: string;
};

export default function MonthFilter({
  currentMonth,
  months,
}: {
  currentMonth: string;
  months: MonthOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentYear, currentMonthNumber] = currentMonth.split("-");
  const years = Array.from(new Set(months.map((month) => month.value.slice(0, 4))));
  const monthsInCurrentYear = months.filter((month) => month.value.startsWith(`${currentYear}-`));

  const handleSelect = (month: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("month", month);
    params.delete("weekStart");
    router.push(`/?${params.toString()}`, { scroll: false });
  };

  const handleYearSelect = (year: string) => {
    const sameMonth = `${year}-${currentMonthNumber}`;
    const nextMonth = months.some((month) => month.value === sameMonth)
      ? sameMonth
      : months.find((month) => month.value.startsWith(`${year}-`))?.value;

    if (nextMonth) handleSelect(nextMonth);
  };

  const handleMonthSelect = (monthNumber: string) => {
    handleSelect(`${currentYear}-${monthNumber}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 shadow-sm border border-slate-200">
        <span className="text-xs font-semibold text-slate-500">연도</span>
        <select
          value={currentYear}
          onChange={(e) => handleYearSelect(e.target.value)}
          className="text-sm border-none bg-transparent font-medium text-slate-800 outline-none cursor-pointer hover:text-indigo-600 transition"
          aria-label="대시보드 연도 선택"
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}년
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 shadow-sm border border-slate-200">
        <span className="text-xs font-semibold text-slate-500">월별</span>
        <select
          value={currentMonthNumber}
          onChange={(e) => handleMonthSelect(e.target.value)}
          className="text-sm border-none bg-transparent font-medium text-slate-800 outline-none cursor-pointer hover:text-indigo-600 transition"
          aria-label="대시보드 월 선택"
        >
          {monthsInCurrentYear.map((month) => {
            const monthNumber = month.value.slice(5, 7);
            return (
              <option key={month.value} value={monthNumber}>
                {Number(monthNumber)}월
              </option>
            );
          })}
        </select>
      </label>
    </div>
  );
}
