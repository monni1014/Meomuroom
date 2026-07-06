"use client";

import { useEffect, useMemo, useState } from "react";
import { eachDayOfInterval, endOfMonth, format, startOfMonth } from "date-fns";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditableTableCellInput } from "@/components/EditableTableCellInput";
import { TablePaintToolbar } from "@/components/TablePaintToolbar";
import { ManualCellData, PaintSelection, emptyManualCell, manualColorClass } from "@/lib/manual-table-colors";

type SlotState = "available" | "closed" | "need_check" | "not_collected";

interface CompetitorSpace {
  id: string;
  name: string;
  displayName: string;
}

interface CompetitorDaySnapshot {
  checkedAt: string | null;
  slots: Partial<Record<number, SlotState>>;
  memo: string | null;
}

interface ManualTableCell {
  tableId: string;
  sectionId: string;
  year: number;
  month: number;
  day: number;
  cellKey: string;
  value: string;
  color: string | null;
}

const COMPETITORS: CompetitorSpace[] = [
  { id: "synergy", name: "시너지", displayName: "시너지" },
  { id: "triground-a", name: "트라이그라운드", displayName: "트라이그라운드 A" },
  { id: "triground-b", name: "트라이그라운드", displayName: "트라이그라운드 B" },
];

const HOURS = Array.from({ length: 17 }, (_, i) => i + 8);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const FIRST_BUSINESS_YEAR = 2025;
const dailySnapshots: Record<string, Record<string, CompetitorDaySnapshot>> = {};

function slotLabel(state: SlotState) {
  if (state === "available") return "가능";
  if (state === "closed") return "마감";
  if (state === "need_check") return "확인";
  return "";
}

function slotClass(state: SlotState) {
  if (state === "available") return "bg-emerald-100 text-emerald-800";
  if (state === "closed") return "bg-slate-300 text-slate-800";
  if (state === "need_check") return "bg-rose-100 text-rose-700";
  return "bg-white text-slate-500";
}

function headerClass(spaceId: string) {
  if (spaceId === "synergy") return "bg-violet-50 text-violet-950";
  if (spaceId === "triground-a") return "bg-emerald-50 text-emerald-950";
  return "bg-sky-50 text-sky-950";
}

function buildYearOptions(currentYear: number) {
  return Array.from(new Set([FIRST_BUSINESS_YEAR, currentYear, currentYear + 1]))
    .filter((year) => year >= FIRST_BUSINESS_YEAR)
    .sort((a, b) => a - b);
}

function getDaySnapshot(spaceId: string, day: Date) {
  return dailySnapshots[spaceId]?.[format(day, "yyyy-MM-dd")] ?? null;
}

function manualCellKey(sectionId: string, day: Date, cellKey: string) {
  return `${sectionId}|${format(day, "yyyy-MM-dd")}|${cellKey}`;
}

function countNeedCheck(space: CompetitorSpace, days: Date[]) {
  return days.reduce((sum, day) => {
    const snapshot = getDaySnapshot(space.id, day);
    if (!snapshot) return sum;
    return sum + HOURS.filter((hour) => snapshot.slots[hour] === "need_check").length;
  }, 0);
}

function countCheckedDays(space: CompetitorSpace, days: Date[]) {
  return days.filter((day) => getDaySnapshot(space.id, day)?.checkedAt).length;
}

export default function CompetitorsView() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [competitorFilter, setCompetitorFilter] = useState<"all" | string>("all");
  const [manualCells, setManualCells] = useState<Record<string, ManualCellData>>({});
  const [paintSelection, setPaintSelection] = useState<PaintSelection>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const yearOptions = buildYearOptions(currentYear);
  const monthDays = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(currentDate), end: endOfMonth(currentDate) }),
    [currentDate]
  );
  const visibleCompetitors =
    competitorFilter === "all"
      ? COMPETITORS
      : COMPETITORS.filter((competitor) => competitor.id === competitorFilter);

  const moveToMonth = (year: number, month: number) => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const moveMonthBy = (amount: number) => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + amount, 1));
  };

  const fetchManualCells = async (year: number, month: number) => {
    try {
      const res = await fetch(`/api/manual-table-cells?tableId=competitors&year=${year}&month=${month}`);
      if (!res.ok) return;
      const cells = (await res.json()) as ManualTableCell[];
      setManualCells(
        cells.reduce<Record<string, ManualCellData>>((acc, cell) => {
          const day = new Date(cell.year, cell.month - 1, cell.day);
          acc[manualCellKey(cell.sectionId, day, cell.cellKey)] = {
            value: cell.value,
            color: cell.color as ManualCellData["color"],
          };
          return acc;
        }, {})
      );
    } catch (error) {
      console.error("Failed to load manual competitor table cells:", error);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchManualCells(currentYear, currentMonth);
  }, [currentYear, currentMonth]);

  const updateManualCell = (sectionId: string, day: Date, cellKey: string, patch: Partial<ManualCellData>) => {
    const key = manualCellKey(sectionId, day, cellKey);
    setManualCells((prev) => ({
      ...prev,
      [key]: {
        ...emptyManualCell(),
        ...prev[key],
        ...patch,
      },
    }));
  };

  const saveManualCell = async (sectionId: string, day: Date, cellKey: string, cell: ManualCellData) => {
    try {
      await fetch("/api/manual-table-cells", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableId: "competitors",
          sectionId,
          year: currentYear,
          month: currentMonth,
          day: day.getDate(),
          cellKey,
          value: cell.value,
          color: cell.color,
        }),
      });
    } catch (error) {
      console.error("Failed to save manual competitor table cell:", error);
    }
  };

  const refresh = async () => {
    setIsRefreshing(true);
    await fetchManualCells(currentYear, currentMonth);
    window.setTimeout(() => setIsRefreshing(false), 300);
  };

  const applyPaintToCell = (sectionId: string, day: Date, cellKey: string) => {
    if (paintSelection === null) return;
    const key = manualCellKey(sectionId, day, cellKey);
    const currentCell = manualCells[key] || emptyManualCell();
    const nextCell = {
      ...currentCell,
      color: paintSelection === "clear" ? null : paintSelection,
    };
    updateManualCell(sectionId, day, cellKey, { color: nextCell.color });
    saveManualCell(sectionId, day, cellKey, nextCell);
  };

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-[1600px] mx-auto w-full">
      <header className="pt-8 pb-2 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">경쟁사 현황</h1>
          <p className="text-sm text-slate-500 mt-1">경쟁사별 예약 상태를 월간 시간표 형식으로 확인합니다.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => moveMonthBy(-1)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 active:scale-95"
          >
            <ChevronLeft className="w-4 h-4" />
            이전
          </button>
          <button
            onClick={() => moveMonthBy(1)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 active:scale-95"
          >
            다음
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 active:scale-95 disabled:bg-slate-400"
          >
            <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
            새로고침
          </button>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-[140px_minmax(0,1fr)_360px] gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 uppercase" htmlFor="competitor-year">
              연도
            </label>
            <select
              id="competitor-year"
              value={currentYear}
              onChange={(event) => moveToMonth(Number(event.target.value), currentMonth)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-hidden focus:border-indigo-500"
            >
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}년
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-black text-slate-400 uppercase">월</p>
            <div className="grid grid-cols-6 md:grid-cols-12 gap-1.5">
              {MONTHS.map((month) => (
                <button
                  key={month}
                  onClick={() => moveToMonth(currentYear, month)}
                  className={cn(
                    "h-10 rounded-xl border text-sm font-black transition active:scale-95",
                    currentMonth === month
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  )}
                >
                  {month}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-black text-slate-400 uppercase">경쟁사 현황</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(["all", ...COMPETITORS.map((competitor) => competitor.id)] as const).map((id) => {
                const competitor = COMPETITORS.find((item) => item.id === id);
                const label = id === "all" ? "전체" : competitor?.displayName;
                return (
                  <button
                    key={id}
                    onClick={() => setCompetitorFilter(id)}
                    className={cn(
                      "h-10 rounded-xl border px-2 text-xs font-black transition active:scale-95",
                      competitorFilter === id
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100 pt-4">
          <TablePaintToolbar selected={paintSelection} onSelect={setPaintSelection} />
        </div>
      </section>

      <div className="space-y-6">
        {visibleCompetitors.map((competitor) => {
          const checkedDays = countCheckedDays(competitor, monthDays);
          const needCheckCount = countNeedCheck(competitor, monthDays);

          return (
            <section key={competitor.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className={cn("border-b border-slate-300 px-4 py-2 text-center text-sm font-black", headerClass(competitor.id))}>
                {competitor.displayName}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[1380px] w-full table-fixed border-collapse text-[11px]">
                  <thead>
                    <tr className="h-6 bg-emerald-50 text-slate-900">
                      <th className="sticky left-0 z-20 w-[92px] border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle">날짜</th>
                      <th className="sticky left-[92px] z-20 w-[76px] border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle">확인</th>
                      {HOURS.map((hour) => (
                        <th key={hour} className="w-[64px] border border-slate-300 px-1 py-0.5 text-center align-middle">
                          {hour}
                        </th>
                      ))}
                      <th className="sticky right-0 z-20 w-[120px] border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle">비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthDays.map((day) => {
                      const snapshot = getDaySnapshot(competitor.id, day);
                      const isWeekend = day.getDay() === 0 || day.getDay() === 6;

                      return (
                        <tr key={`${competitor.id}-${day.toISOString()}`} className="group h-6 hover:bg-slate-50">
                          <td className={cn("sticky left-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-semibold group-hover:bg-slate-50", isWeekend && "text-red-500")}>
                            {format(day, "MM월 dd일")}
                          </td>
                          <td className="sticky left-[92px] z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-bold text-slate-500 group-hover:bg-slate-50">
                            {snapshot?.checkedAt ? format(new Date(snapshot.checkedAt), "HH:mm") : "-"}
                          </td>
                          {HOURS.map((hour) => {
                            const state = snapshot?.slots[hour] || "not_collected";
                            const editableKey = `hour-${hour}`;
                            const manualKey = manualCellKey(competitor.id, day, editableKey);
                            const manualCell = manualCells[manualKey] || emptyManualCell();
                            const manualClass = manualColorClass(manualCell.color);
                            return (
                              <td
                                key={`${competitor.id}-${day.toISOString()}-${hour}`}
                                onMouseDown={(event) => {
                                  if (paintSelection !== null) {
                                    event.preventDefault();
                                    applyPaintToCell(competitor.id, day, editableKey);
                                  }
                                }}
                                className={cn(
                                  "h-6 border border-slate-300 p-0 text-center align-middle font-semibold",
                                  manualClass || slotClass(state),
                                  paintSelection !== null && "cursor-crosshair"
                                )}
                              >
                                <EditableTableCellInput
                                  ariaLabel={`${competitor.displayName} ${format(day, "MM월 dd일")} ${hour}시 수동 입력`}
                                  value={manualCell.value}
                                  placeholder={slotLabel(state)}
                                  disabled={paintSelection !== null}
                                  onChange={(value) => updateManualCell(competitor.id, day, editableKey, { value })}
                                  onCommit={(value) =>
                                    saveManualCell(competitor.id, day, editableKey, {
                                      ...manualCell,
                                      value,
                                    })
                                  }
                                  className="text-center text-slate-800"
                                />
                              </td>
                            );
                          })}
                          <td className="sticky right-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-semibold text-slate-600 group-hover:bg-slate-50">
                            {snapshot?.memo || "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 font-black text-slate-900">
                      <td className="sticky left-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">월 총합</td>
                      <td className="sticky left-[92px] z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">
                        {checkedDays}일
                      </td>
                      <td className="border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle" colSpan={HOURS.length}>
                        확인 필요
                      </td>
                      <td className="sticky right-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">
                        {needCheckCount}건
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
