"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth } from "date-fns";
import { ChevronLeft, ChevronRight, MessageSquareText, RefreshCw, Save, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { getKstDateParts } from "@/lib/kst-time";
import { EditableTableCellInput } from "@/components/EditableTableCellInput";
import {
  MONTHLY_GRID_BODY_ROW_CLASS,
  MONTHLY_GRID_END_DIVIDER_CLASS,
  MONTHLY_GRID_HEADER_ROW_CLASS,
  MONTHLY_GRID_TABLE_CLASS,
  MONTHLY_GRID_TOTAL_LEFT_CLASS,
  MonthlyGridColGroup,
} from "@/components/MonthlyGridLayout";
import { TablePaintToolbar } from "@/components/TablePaintToolbar";
import {
  ManualCellData,
  PaintSelection,
  emptyManualCell,
  manualCellDataEquals,
  manualColorClass,
  reconcileDirtyKey,
} from "@/lib/manual-table-colors";

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

const ROOMS = ["머무룸1", "머무룸2", "머무룸3"] as const;
type RoomName = (typeof ROOMS)[number];
// 월간표는 영업시간 기준으로 08시부터 다음 날 02시까지 표시한다.
// 자정 이후 00시와 01시는 각각 24시와 25시 칸을 사용한다.
const HOURS = Array.from({ length: 18 }, (_, i) => i + 8);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const FIRST_BUSINESS_YEAR = 2025;
const ROOM3_GRAND_OPEN_DATE = "2026-07-15";

function startHour(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  const hour = start.getHours() + start.getMinutes() / 60;
  return hour < 2 ? hour + 24 : hour;
}

function endHour(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  const end = new Date(reservation.endTime);
  const elapsedHours = Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60));
  return startHour(reservation) + elapsedHours;
}

function durationHours(reservation: Reservation) {
  const start = new Date(reservation.startTime);
  const end = new Date(reservation.endTime);
  return Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60));
}

function countsAsTime(reservation: Reservation) {
  return reservation.status !== "CANCELLED" || reservation.isNoShow;
}

function displayPriority(reservation: Reservation) {
  if (reservation.status !== "CANCELLED") return 0;
  if (reservation.isNoShow) return 1;
  if (reservation.price > 0) return 2;
  return 3;
}

function overlappingReservations(reservations: Reservation[], hour: number) {
  return reservations.filter((reservation) => startHour(reservation) < hour + 1 && endHour(reservation) > hour);
}

function overlappingReservationsForCell(reservations: Reservation[], hour: number) {
  return overlappingReservations(reservations, hour).sort((a, b) => {
    const priority = displayPriority(a) - displayPriority(b);
    if (priority !== 0) return priority;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });
}

function reservationSlots(reservation: Reservation) {
  return HOURS.filter((hour) => startHour(reservation) < hour + 1 && endHour(reservation) > hour);
}

function reservationTokens(reservation: Reservation) {
  const tokens: { kind: "status" | "headCount" | "detail" | "price"; label: string }[] = [];
  const headCount = reservation.usageLog?.headCount;
  const detail = reservation.usageLog?.detail || reservation.usageLog?.purpose;

  if (reservation.status === "CANCELLED" && !reservation.isNoShow) {
    tokens.push({ kind: "status", label: "취소" });
  } else {
    if (reservation.isNoShow) tokens.push({ kind: "status", label: "노쇼" });
    if (headCount) tokens.push({ kind: "headCount", label: `${headCount}인` });
    if (detail) tokens.push({ kind: "detail", label: detail });
  }

  if (reservation.price > 0) {
    tokens.push({ kind: "price", label: reservation.price.toLocaleString() });
  }

  return tokens;
}

function cellLabel(reservation: Reservation, hour: number) {
  const slots = reservationSlots(reservation);
  const slotIndex = slots.indexOf(hour);
  if (slotIndex === -1) return "";

  const tokens = reservationTokens(reservation);
  if (tokens.length === 0) return "";
  if (slots.length === 1) {
    const firstContent = tokens.find((token) => token.kind !== "detail" && token.kind !== "price");
    const price = tokens.find((token) => token.kind === "price");
    return [firstContent?.label, price?.label].filter(Boolean).join(" / ");
  }

  const labels = Array.from({ length: slots.length }, () => "");
  const priceToken = tokens.find((token) => token.kind === "price");
  const contentTokens = tokens.filter((token) => token.kind !== "price");
  const contentCapacity = priceToken ? labels.length - 1 : labels.length;
  contentTokens.slice(0, contentCapacity).forEach((token, index) => {
    labels[index] = token.label;
  });
  if (priceToken) labels[labels.length - 1] = priceToken.label;

  return labels[slotIndex] || "";
}

function isReservationPriceCell(reservation: Reservation, hour: number) {
  const slots = reservationSlots(reservation);
  return reservation.price > 0 && slots[slots.length - 1] === hour;
}

function reservationMemoData(reservation: Reservation) {
  const detail = reservation.usageLog?.detail || reservation.usageLog?.purpose;
  const slots = reservationSlots(reservation);
  const tokens = reservationTokens(reservation);
  const priceToken = tokens.find((token) => token.kind === "price");
  const contentTokens = tokens.filter((token) => token.kind !== "price");
  const detailIndex = contentTokens.findIndex((token) => token.kind === "detail");
  const contentCapacity = priceToken ? slots.length - 1 : slots.length;
  return {
    purpose: detail && (slots.length <= 1 || detailIndex >= contentCapacity) ? detail : null,
    coffeeCount: reservation.usageLog?.coffeeCount || 0,
    hasCoupon: reservation.discount > 0,
  };
}

function cellStyle(reservation: Reservation, isWeekend: boolean) {
  if (reservation.status === "CANCELLED" && !reservation.isNoShow) {
    return "bg-[#BFBFBF] text-slate-950";
  }
  if (reservation.isNoShow) {
    return "bg-[#BFBFBF] text-slate-950";
  }
  if (reservation.source === "spacecloud") {
    return isWeekend ? "bg-[#C65911] text-slate-950" : "bg-[#2F75B5] text-slate-950";
  }
  return isWeekend ? "bg-[#FCE4D6] text-slate-950" : "bg-[#DDEBF7] text-slate-950";
}

function formatNumber(value: number) {
  return value > 0 ? value.toLocaleString() : "-";
}

function reservationStatusLabel(reservation: Reservation) {
  if (reservation.status !== "CANCELLED") return "확정";
  return reservation.isNoShow ? "노쇼" : "취소";
}

function reservationTooltipLabel(reservation: Reservation) {
  const status = reservationStatusLabel(reservation);
  const time = `${format(new Date(reservation.startTime), "HH:mm")}-${format(new Date(reservation.endTime), "HH:mm")}`;
  const price = reservation.price > 0 ? ` ${reservation.price.toLocaleString()}원` : "";
  return `[${status}] ${reservation.customerName || "이름 없음"} ${time}${price}`;
}

function revenueTooltip(reservations: Reservation[]) {
  const paidItems = reservations.filter((reservation) => reservation.price > 0);
  if (paidItems.length === 0) return "";
  return paidItems.map(reservationTooltipLabel).join("\n");
}

function buildYearOptions(currentYear: number, reservations: Reservation[]) {
  return Array.from(
    new Set([
      currentYear,
      currentYear + 1,
      ...reservations
        .map((reservation) => getKstDateParts(new Date(reservation.startTime)).year)
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
  const [savedManualCells, setSavedManualCells] = useState<Record<string, ManualCellData>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [paintSelection, setPaintSelection] = useState<PaintSelection>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [roomFilter, setRoomFilter] = useState<"all" | RoomName>("all");

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReservations();
  }, []);

  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const yearOptions = useMemo(() => buildYearOptions(currentYear, reservations), [currentYear, reservations]);
  const monthDays = eachDayOfInterval({ start: startOfMonth(currentDate), end: endOfMonth(currentDate) });
  const visibleRooms = roomFilter === "all" ? ROOMS : ROOMS.filter((room) => room === roomFilter);

  const moveToMonth = (year: number, month: number) => {
    if (dirtyKeys.size > 0) {
      setEditMessage("저장하거나 되돌린 뒤 다른 월로 이동하세요.");
      return;
    }
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const moveMonthBy = (amount: number) => {
    if (dirtyKeys.size > 0) {
      setEditMessage("저장하거나 되돌린 뒤 다른 월로 이동하세요.");
      return;
    }
    setCurrentDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + amount, 1));
  };

  const requestManualCells = useCallback(async (year: number, month: number) => {
    const res = await fetch(`/api/manual-table-cells?tableId=monthly-table&year=${year}&month=${month}`, { cache: "no-store" });
    if (!res.ok) throw new Error("월간표 수동 입력을 불러오지 못했습니다.");
    const cells = (await res.json()) as ManualTableCell[];
    return cells.reduce<Record<string, ManualCellData>>((acc, cell) => {
      const day = new Date(cell.year, cell.month - 1, cell.day);
      acc[manualCellKey(cell.sectionId, day, cell.cellKey)] = {
        value: cell.value,
        color: cell.color as ManualCellData["color"],
      };
      return acc;
    }, {});
  }, []);

  const fetchManualCells = useCallback(async (year: number, month: number) => {
    try {
      const loadedCells = await requestManualCells(year, month);
      setManualCells(loadedCells);
      setSavedManualCells(loadedCells);
      setDirtyKeys(new Set());
    } catch (error) {
      console.error("Failed to load manual monthly table cells:", error);
      setEditMessage(error instanceof Error ? error.message : "월간표 수동 입력을 불러오지 못했습니다.");
    }
  }, [requestManualCells]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchManualCells(currentYear, currentMonth);
  }, [currentYear, currentMonth, fetchManualCells]);

  useEffect(() => {
    const refreshLinkedData = () => {
      fetchReservations(false);
      if (dirtyKeys.size === 0) fetchManualCells(currentYear, currentMonth);
    };
    const timer = window.setInterval(refreshLinkedData, 30_000);
    window.addEventListener("focus", refreshLinkedData);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshLinkedData);
    };
  }, [currentYear, currentMonth, dirtyKeys.size, fetchManualCells]);

  const updateManualCell = (sectionId: string, day: Date, cellKey: string, patch: Partial<ManualCellData>) => {
    const key = manualCellKey(sectionId, day, cellKey);
    const currentCell = { ...emptyManualCell(), ...manualCells[key] };
    const nextCell = { ...currentCell, ...patch };
    const savedCell = { ...emptyManualCell(), ...savedManualCells[key] };
    const changedFromCurrent = !manualCellDataEquals(currentCell, nextCell);
    const changedFromSaved = !manualCellDataEquals(savedCell, nextCell);

    if (changedFromCurrent) {
      setManualCells((previous) => ({
        ...previous,
        [key]: nextCell,
      }));
    }
    setDirtyKeys((previous) => reconcileDirtyKey(previous, key, changedFromSaved));
    if (!changedFromCurrent) return;
    setEditMessage(null);
  };

  const saveManualCell = async (
    sectionId: string,
    day: Date,
    cellKey: string,
    cell: ManualCellData,
    year: number,
    month: number,
  ) => {
    const response = await fetch("/api/manual-table-cells", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableId: "monthly-table",
        sectionId,
        year,
        month,
        day: day.getDate(),
        cellKey,
        value: cell.value,
        color: cell.color,
      }),
    });
    if (!response.ok) throw new Error("월간표 변경사항을 저장하지 못했습니다.");
  };

  const refreshAll = () => {
    fetchReservations(true);
    if (dirtyKeys.size === 0) {
      fetchManualCells(currentYear, currentMonth);
    } else {
      setEditMessage("저장 전 변경사항이 있어 수동 입력은 새로고침하지 않았습니다.");
    }
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
  };

  const undoChanges = () => {
    setManualCells(savedManualCells);
    setDirtyKeys(new Set());
    setEditMessage("저장 전 변경사항을 되돌렸습니다.");
  };

  const saveChanges = async () => {
    if (dirtyKeys.size === 0 || isSaving) return;
    setIsSaving(true);
    setEditMessage(null);
    const draft = manualCells;
    const keysToSave = [...dirtyKeys];
    const savingYear = currentYear;
    const savingMonth = currentMonth;

    try {
      for (const key of keysToSave) {
        const [sectionId, dateKey, cellKey] = key.split("|");
        const day = new Date(`${dateKey}T12:00:00`);
        await saveManualCell(sectionId, day, cellKey, draft[key] || emptyManualCell(), savingYear, savingMonth);
      }

      const verifiedCells = await requestManualCells(savingYear, savingMonth);
      const mismatched = keysToSave.some((key) => {
        const expected = draft[key] || emptyManualCell();
        const actual = verifiedCells[key] || emptyManualCell();
        return expected.value.trim() !== actual.value.trim() || expected.color !== actual.color;
      });
      if (mismatched) throw new Error("저장값 확인에 실패했습니다. 변경사항은 화면에 유지됩니다.");

      setManualCells(verifiedCells);
      setSavedManualCells(verifiedCells);
      setDirtyKeys(new Set());
      setEditMessage("저장되었습니다.");
    } catch (error) {
      setEditMessage(error instanceof Error ? error.message : "월간표 변경사항을 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-[1600px] mx-auto w-full">
      <header className="pt-8 pb-2 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">월간 예약표</h1>
          <p className="text-sm text-slate-500 mt-1">머무룸1·2·3 예약을 시간표 형식으로 확인합니다.</p>
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
            <div className="grid grid-cols-4 gap-1.5">
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TablePaintToolbar
              selected={paintSelection}
              onSelect={setPaintSelection}
              showMonthlyOnlyColors
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={undoChanges}
                disabled={dirtyKeys.size === 0 || isSaving}
                className="inline-flex h-9 items-center gap-1.5 rounded border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
                되돌리기
              </button>
              <button
                type="button"
                onClick={saveChanges}
                disabled={dirtyKeys.size === 0 || isSaving}
                className="inline-flex h-9 items-center gap-1.5 rounded bg-emerald-600 px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? "저장 중" : `저장${dirtyKeys.size > 0 ? ` (${dirtyKeys.size})` : ""}`}
              </button>
            </div>
          </div>
          {editMessage && <p className="mt-2 text-xs font-bold text-slate-500">{editMessage}</p>}
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
            const roomHeaderClass = room === "머무룸1"
              ? "bg-amber-100 text-amber-950"
              : room === "머무룸2"
                ? "bg-sky-100 text-sky-950"
                : "bg-orange-100 text-orange-950";

            return (
              <section key={room} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className={cn("border-b border-slate-300 px-4 py-2 text-center text-sm font-black", roomHeaderClass)}>
                  {room}
                </div>
                <div className="overflow-x-auto">
                  <table className={MONTHLY_GRID_TABLE_CLASS}>
                    <MonthlyGridColGroup hours={HOURS} />
                    <thead>
                      <tr className={MONTHLY_GRID_HEADER_ROW_CLASS}>
                        <th className="sticky left-0 z-20 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle">날짜</th>
                        <th className={cn("sticky z-20 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>시간 합계</th>
                        {HOURS.map((hour) => (
                          <th key={hour} className="border border-slate-300 px-1 py-0.5 text-center align-middle">
                            {hour}
                          </th>
                        ))}
                        <th className={cn("sticky right-0 z-20 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_END_DIVIDER_CLASS)}>일 매출액</th>
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
                        const dayRevenueTitle = revenueTooltip(dayReservations);
                        const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                        const isRoom3GrandOpening = room === "머무룸3"
                          && format(day, "yyyy-MM-dd") === ROOM3_GRAND_OPEN_DATE;
                        const grandOpeningLabelStartHour = isRoom3GrandOpening
                          ? HOURS.slice(0, -1)
                              .filter((hour, index) => (
                                HOURS[index + 1] === hour + 1
                                && overlappingReservations(dayReservations, hour).length === 0
                                && overlappingReservations(dayReservations, hour + 1).length === 0
                              ))
                              .sort((a, b) => Math.abs(a + 0.5 - 16) - Math.abs(b + 0.5 - 16))[0]
                          : undefined;

                        return (
                          <tr key={`${room}-${day.toISOString()}`} className={MONTHLY_GRID_BODY_ROW_CLASS}>
                            <td className={cn("sticky left-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-semibold group-hover:bg-slate-50", isWeekend && "text-red-500")}>
                              {format(day, "MM월 dd일")}
                            </td>
                            <td className={cn("sticky z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-bold text-slate-800 group-hover:bg-slate-50", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>
                              {dayHours > 0 ? Number(dayHours.toFixed(1)) : "-"}
                            </td>
                            {HOURS.map((hour) => {
                              const cellReservations = overlappingReservationsForCell(dayReservations, hour);
                              const primary = cellReservations[0];
                              const label = primary ? cellLabel(primary, hour) : "";
                              const grandOpeningLabel = !primary && grandOpeningLabelStartHour !== undefined
                                ? hour === grandOpeningLabelStartHour
                                  ? "Grand"
                                  : hour === grandOpeningLabelStartHour + 1
                                    ? "Open"
                                    : ""
                                : "";
                              const editableKey = `hour-${hour}`;
                              const manualKey = manualCellKey(room, day, editableKey);
                              const manualCell = manualCells[manualKey] || emptyManualCell();
                              const manualClass = manualColorClass(manualCell.color);
                              const isPriceCell = primary ? isReservationPriceCell(primary, hour) : false;
                              const isReservationStart = primary
                                ? reservationSlots(primary)[0] === hour
                                : false;
                              const memo = primary && isReservationStart
                                ? reservationMemoData(primary)
                                : { purpose: null, coffeeCount: 0, hasCoupon: false };
                              const hasMemo = Boolean(memo.purpose || memo.coffeeCount > 0 || memo.hasCoupon);
                              const memoLabel = [
                                memo.purpose ? `목적 ${memo.purpose}` : null,
                                memo.coffeeCount > 0 ? `커피 ${memo.coffeeCount}잔` : null,
                                memo.hasCoupon ? "쿠폰 사용" : null,
                              ].filter(Boolean).join(", ");

                              return (
                                <td
                                  key={`${room}-${day.toISOString()}-${hour}`}
                                  onMouseDown={(event) => {
                                    if (paintSelection !== null) {
                                      event.preventDefault();
                                      applyPaintToCell(room, day, editableKey);
                                    }
                                  }}
                                  onDoubleClick={(event) => {
                                    if (!primary || !isPriceCell || paintSelection !== null) return;
                                    event.preventDefault();
                                    router.push(`/usage?selected=${encodeURIComponent(primary.id)}`);
                                  }}
                                  className={cn(
                                    "relative h-6 overflow-visible border border-slate-300 p-0 text-center align-middle font-semibold",
                                    manualClass || (primary
                                      ? cellStyle(primary, isWeekend)
                                      : isRoom3GrandOpening
                                        ? "bg-orange-100 text-orange-950"
                                        : "bg-white text-slate-500"),
                                    paintSelection !== null && "cursor-crosshair",
                                    isPriceCell && paintSelection === null && "cursor-pointer",
                                    hasMemo && "hover:z-40 focus-within:z-40"
                                  )}
                                  title={
                                    primary
                                      ? cellReservations
                                          .map(reservationTooltipLabel)
                                          .join(" / ")
                                      : ""
                                  }
                                >
                                  <EditableTableCellInput
                                    ariaLabel={`${room} ${format(day, "MM월 dd일")} ${hour}시 수동 입력`}
                                    value={manualCell.value}
                                    placeholder={label || grandOpeningLabel}
                                    disabled={paintSelection !== null}
                                    onChange={(value) => updateManualCell(room, day, editableKey, { value })}
                                    onCommit={(value) => updateManualCell(room, day, editableKey, { value })}
                                    className={cn(
                                      primary ? "text-current" : "text-slate-800",
                                      isPriceCell && paintSelection === null && "cursor-pointer",
                                    )}
                                  />
                                  {hasMemo && (
                                    <span
                                      className="group/memo absolute right-0.5 top-0.5 z-30 grid h-4 w-4 place-items-center rounded-sm border border-[#8B5E3C] bg-white text-[#7A4B2A] shadow-sm"
                                      aria-label={memoLabel}
                                      title=""
                                      tabIndex={0}
                                    >
                                      <MessageSquareText className="h-2.5 w-2.5" />
                                      <span className="pointer-events-none invisible absolute left-1/2 top-[calc(100%+6px)] z-[70] flex min-w-[128px] -translate-x-1/2 flex-col items-center gap-1 whitespace-nowrap rounded-md border border-[#D8C2B2] bg-white px-2.5 py-2 text-center text-[10px] font-bold text-slate-800 opacity-0 shadow-xl transition group-hover/memo:visible group-hover/memo:opacity-100 group-focus/memo:visible group-focus/memo:opacity-100">
                                        <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-[#D8C2B2] bg-white" />
                                        {memo.purpose && <span>목적: {memo.purpose}</span>}
                                        {memo.coffeeCount > 0 && <span>커피: {memo.coffeeCount}잔</span>}
                                        {memo.hasCoupon && (
                                          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[9px] font-semibold text-rose-600">
                                            🎟️ 쿠폰
                                          </span>
                                        )}
                                      </span>
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                            <td
                              className={cn("sticky right-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-bold text-slate-900 group-hover:bg-slate-50", MONTHLY_GRID_END_DIVIDER_CLASS)}
                              title={dayRevenueTitle}
                            >
                              {formatNumber(dayRevenue)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-100 font-black text-slate-900">
                        <td className="sticky left-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">월 총합</td>
                        <td className={cn("sticky z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>
                          {Number(monthHours.toFixed(1))}
                        </td>
                        <td className="border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle" colSpan={HOURS.length}>
                          월 매출액
                        </td>
                        <td className={cn("sticky right-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_END_DIVIDER_CLASS)}>
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
