"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth } from "date-fns";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditableTableCellInput } from "@/components/EditableTableCellInput";
import { TablePaintToolbar } from "@/components/TablePaintToolbar";
import { ManualCellData, PaintSelection, emptyManualCell, manualColorClass } from "@/lib/manual-table-colors";

interface UsageLog {
  id: string;
  headCount: number;
  coffeeCount: number;
  purpose: string | null;
  detail: string | null;
  extraTime: number;
  extraPrice: number | null;
  isExtraPaid: boolean;
  extraPaymentMethod: string | null;
}

interface Reservation {
  id: string;
  source: string;
  roomName: string;
  customerName: string | null;
  phone: string | null;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
  notified: boolean;
  price: number;
  discount: number;
  status: string;
  isNoShow: boolean;
  paymentMethod: string | null;
  isPaid: boolean;
  memo: string | null;
  complaints: string | null;
  isCleanUpBad: boolean;
  emailId: string | null;
  usageLog: UsageLog | null;
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

const ROOMS = ["머무룸1", "머무룸2"] as const;
const HOURS = Array.from({ length: 17 }, (_, i) => i + 8);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const FIRST_BUSINESS_YEAR = 2025;

function startHour(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  return start.getHours() + start.getMinutes() / 60;
}

function endHour(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  const end = new Date(reservation.endTime);
  if (!isSameDay(start, end) && end.getHours() === 0 && end.getMinutes() === 0) return 24;
  return end.getHours() + end.getMinutes() / 60;
}

function durationHours(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  const end = new Date(reservation.endTime);
  return Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60));
}

function countsAsTime(reservation: Reservation) {
  return reservation.status !== "CANCELLED" || reservation.isNoShow;
}

function overlappingReservations(reservations: Reservation[], hour: number) {
  return reservations.filter((reservation) => startHour(reservation) < hour + 1 && endHour(reservation) > hour);
}

function cellLabel(reservation: Reservation, hour: number) {
  const startsHere = startHour(reservation) >= hour && startHour(reservation) < hour + 1;
  const endsHere = endHour(reservation) > hour && endHour(reservation) <= hour + 1;
  const headCount = reservation.usageLog?.headCount;
  const detail = reservation.usageLog?.detail || reservation.usageLog?.purpose;
  const price = reservation.price > 0 ? reservation.price.toLocaleString() : "";

  if (reservation.status === "CANCELLED" && !reservation.isNoShow) {
    if (startsHere) return reservation.price > 0 ? "취소" : "";
    if (endsHere) return price;
    return "";
  }
  if (reservation.isNoShow && startsHere) return "노쇼";
  if (startsHere && headCount) return detail ? `${headCount}인 ${detail}` : `${headCount}인`;
  if (startsHere && detail) return detail;
  if (endsHere) return price;
  return "";
}

function cellStyle(reservation: Reservation, isWeekend: boolean) {
  if (reservation.status === "CANCELLED" && !reservation.isNoShow) {
    return "bg-slate-200 text-slate-600";
  }
  if (reservation.isNoShow) {
    return "bg-orange-200 text-orange-950";
  }
  if (reservation.source === "spacecloud") {
    return isWeekend ? "bg-[#C65911] text-slate-950" : "bg-[#2F75B5] text-slate-950";
  }
  return isWeekend ? "bg-[#FCE4D6] text-slate-950" : "bg-[#DDEBF7] text-slate-950";
}

function formatNumber(value: number) {
  return value > 0 ? value.toLocaleString() : "-";
}

function buildYearOptions(currentYear: number, reservations: Reservation[]) {
  return Array.from(
    new Set([
      currentYear,
      currentYear + 1,
      ...reservations
        .map((reservation) => new Date(reservation.startTime).getFullYear())
        .filter((year) => year >= FIRST_BUSINESS_YEAR),
    ])
  )
    .filter((year) => year >= FIRST_BUSINESS_YEAR)
    .sort((a, b) => a - b);
}

function manualCellKey(sectionId: string, day: Date, cellKey: string) {
  return `${sectionId}|${format(day, "yyyy-MM-dd")}|${cellKey}`;
}

export default function MonthlyTableView() {
  const router = useRouter();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [manualCells, setManualCells] = useState<Record<string, ManualCellData>>({});
  const [paintSelection, setPaintSelection] = useState<PaintSelection>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [roomFilter, setRoomFilter] = useState<"all" | "머무룸1" | "머무룸2">("all");

  const fetchReservations = async (showLoading = true) => {
    try {
      if (showLoading) setIsLoading(true);
      const res = await fetch("/api/reservations");
      if (res.ok) setReservations(await res.json());
    } catch (error) {
      console.error("Failed to load reservations:", error);
    } finally {
      if (showLoading) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReservations();
  }, []);

  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const yearOptions = useMemo(() => buildYearOptions(currentYear, reservations), [currentYear, reservations]);
  const monthDays = eachDayOfInterval({ start: startOfMonth(currentDate), end: endOfMonth(currentDate) });
  const visibleRooms = roomFilter === "all" ? ROOMS : ROOMS.filter((room) => room === roomFilter);

  const moveToMonth = (year: number, month: number) => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const moveMonthBy = (amount: number) => {
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + amount, 1));
  };

  const fetchManualCells = async (year: number, month: number) => {
    try {
      const res = await fetch(`/api/manual-table-cells?tableId=monthly-table&year=${year}&month=${month}`);
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
      console.error("Failed to load manual monthly table cells:", error);
    }
  };

  useEffect(() => {
    fetchManualCells(currentYear, currentMonth);
  }, [currentYear, currentMonth]);

  useEffect(() => {
    const refreshLinkedData = () => {
      fetchReservations(false);
      fetchManualCells(currentYear, currentMonth);
    };
    const timer = window.setInterval(refreshLinkedData, 30_000);
    window.addEventListener("focus", refreshLinkedData);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshLinkedData);
    };
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
          tableId: "monthly-table",
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
      console.error("Failed to save manual monthly table cell:", error);
    }
  };

  const refreshAll = () => {
    fetchReservations(true);
    fetchManualCells(currentYear, currentMonth);
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
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">월간 예약표</h1>
          <p className="text-sm text-slate-500 mt-1">머무룸1과 머무룸2 예약을 시간표 형식으로 확인합니다.</p>
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
            onClick={refreshAll}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 active:scale-95 disabled:bg-slate-400"
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
            새로고침
          </button>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-[140px_minmax(0,1fr)_260px] gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 uppercase" htmlFor="monthly-table-year">
              연도
            </label>
            <select
              id="monthly-table-year"
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
            <p className="text-xs font-black text-slate-400 uppercase">공간</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(["all", ...ROOMS] as const).map((room) => (
                <button
                  key={room}
                  onClick={() => setRoomFilter(room)}
                  className={cn(
                    "h-10 rounded-xl border text-sm font-black transition active:scale-95",
                    roomFilter === room
                      ? "border-indigo-600 bg-indigo-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  )}
                >
                  {room === "all" ? "전체" : room.replace("머무룸", "룸")}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100 pt-4">
          <TablePaintToolbar selected={paintSelection} onSelect={setPaintSelection} />
        </div>
      </section>

      {isLoading ? (
        <div className="rounded-2xl border border-slate-100 bg-white p-12 text-center text-sm font-semibold text-slate-400">
          예약 데이터를 불러오는 중입니다.
        </div>
      ) : (
        <div className="space-y-6">
          {visibleRooms.map((room) => {
            const roomReservations = reservations
              .filter((reservation) => reservation.roomName === room)
              .filter((reservation) => isSameMonth(new Date(reservation.startTime), currentDate));
            const monthHours = roomReservations
              .filter(countsAsTime)
              .reduce((sum, reservation) => sum + durationHours(reservation), 0);
            const monthRevenue = roomReservations.reduce((sum, reservation) => sum + reservation.price, 0);
            const roomHeaderClass = room === "머무룸1" ? "bg-amber-100 text-amber-950" : "bg-sky-100 text-sky-950";

            return (
              <section key={room} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className={cn("border-b border-slate-300 px-4 py-2 text-center text-sm font-black", roomHeaderClass)}>
                  {room}
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-[1380px] w-full table-fixed border-collapse text-[12px]">
                    <thead>
                      <tr className="bg-emerald-50 text-slate-900">
                        <th className="sticky left-0 z-20 w-[92px] border border-slate-300 bg-emerald-50 px-2 py-1.5">날짜</th>
                        <th className="sticky left-[92px] z-20 w-[76px] border border-slate-300 bg-emerald-50 px-2 py-1.5 text-right">시간 합계</th>
                        {HOURS.map((hour) => (
                          <th key={hour} className="w-[64px] border border-slate-300 px-2 py-1.5 text-right">
                            {hour}
                          </th>
                        ))}
                        <th className="sticky right-0 z-20 w-[92px] border border-slate-300 bg-emerald-50 px-2 py-1.5 text-right">일 매출액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthDays.map((day) => {
                        const dayReservations = roomReservations
                          .filter((reservation) => isSameDay(new Date(reservation.startTime), day))
                          .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
                        const dayHours = dayReservations
                          .filter(countsAsTime)
                          .reduce((sum, reservation) => sum + durationHours(reservation), 0);
                        const dayRevenue = dayReservations.reduce((sum, reservation) => sum + reservation.price, 0);
                        const isWeekend = day.getDay() === 0 || day.getDay() === 6;

                        return (
                          <tr key={`${room}-${day.toISOString()}`} className="group hover:bg-slate-50">
                            <td className={cn("sticky left-0 z-10 border border-slate-300 bg-white px-2 py-1.5 text-center font-semibold group-hover:bg-slate-50", isWeekend && "text-red-500")}>
                              {format(day, "MM월 dd일")}
                            </td>
                            <td className="sticky left-[92px] z-10 border border-slate-300 bg-white px-2 py-1.5 text-right font-bold text-slate-800 group-hover:bg-slate-50">
                              {dayHours > 0 ? Number(dayHours.toFixed(1)) : "-"}
                            </td>
                            {HOURS.map((hour) => {
                              const cellReservations = overlappingReservations(dayReservations, hour);
                              const primary = cellReservations[0];
                              const label = primary ? cellLabel(primary, hour) : "";
                              const editableKey = `hour-${hour}`;
                              const manualKey = manualCellKey(room, day, editableKey);
                              const manualCell = manualCells[manualKey] || emptyManualCell();
                              const manualClass = manualColorClass(manualCell.color);

                              return (
                                <td
                                  key={`${room}-${day.toISOString()}-${hour}`}
                                  onMouseDown={(event) => {
                                    if (paintSelection !== null) {
                                      event.preventDefault();
                                      applyPaintToCell(room, day, editableKey);
                                    }
                                  }}
                                  onDoubleClick={() => {
                                    if (primary) router.push(`/usage?selected=${primary.id}`);
                                  }}
                                  className={cn(
                                    "h-7 border border-slate-300 px-1.5 py-1 text-right align-middle font-semibold",
                                    manualClass || (primary ? cellStyle(primary, isWeekend) : "bg-white text-slate-500"),
                                    paintSelection !== null && "cursor-crosshair"
                                  )}
                                  title={
                                    primary
                                      ? cellReservations
                                          .map((reservation) => `${reservation.customerName || ""} ${format(new Date(reservation.startTime), "HH:mm")}-${format(new Date(reservation.endTime), "HH:mm")}`)
                                          .join(" / ")
                                      : ""
                                  }
                                >
                                  <span className="block truncate">{label}</span>
                                  <EditableTableCellInput
                                    ariaLabel={`${room} ${format(day, "MM월 dd일")} ${hour}시 수동 입력`}
                                    value={manualCell.value}
                                    disabled={paintSelection !== null}
                                    onChange={(value) => updateManualCell(room, day, editableKey, { value })}
                                    onCommit={(value) =>
                                      saveManualCell(room, day, editableKey, {
                                        ...manualCell,
                                        value,
                                      })
                                    }
                                    className={cn(primary ? "text-current" : "text-slate-800", label && "mt-0.5")}
                                  />
                                </td>
                              );
                            })}
                            <td className="sticky right-0 z-10 border border-slate-300 bg-white px-2 py-1.5 text-right font-bold text-slate-900 group-hover:bg-slate-50">
                              {formatNumber(dayRevenue)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-100 font-black text-slate-900">
                        <td className="sticky left-0 z-20 border border-slate-400 bg-slate-100 px-2 py-1.5 text-center">월 총합</td>
                        <td className="sticky left-[92px] z-20 border border-slate-400 bg-slate-100 px-2 py-1.5 text-right">
                          {Number(monthHours.toFixed(1))}
                        </td>
                        <td className="border border-slate-400 bg-slate-100 px-2 py-1.5 text-left" colSpan={HOURS.length}>
                          월 매출액
                        </td>
                        <td className="sticky right-0 z-20 border border-slate-400 bg-slate-100 px-2 py-1.5 text-right">
                          {monthRevenue.toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
