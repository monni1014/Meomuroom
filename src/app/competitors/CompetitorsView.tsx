"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { eachDayOfInterval, endOfMonth, format, startOfMonth } from "date-fns";
import { ChevronLeft, ChevronRight, RefreshCw, Save, Undo2 } from "lucide-react";
import { EditableTableCellInput } from "@/components/EditableTableCellInput";
import { TablePaintToolbar } from "@/components/TablePaintToolbar";
import { ManualCellData, PaintSelection, emptyManualCell, manualColorClass } from "@/lib/manual-table-colors";
import { cn } from "@/lib/utils";
import type { CompetitorSnapshotPayload } from "@/lib/competitor-snapshots";

type SlotState = "available" | "closed" | "policy_closed" | "need_check" | "not_collected";

interface CompetitorSpace {
  id: string;
  displayName: string;
}

interface SlotSnapshot {
  state: SlotState;
  opportunityLostRooms: string[];
  cancellationPending: boolean;
  bookingNumber: number | null;
  bookingGroup: string | null;
}

interface CompetitorDaySnapshot {
  checkedAt: string | null;
  slots: Record<string, SlotSnapshot>;
}

interface CancellationSnapshot {
  competitorId: string;
  dateKey: string;
  startHour: number;
  endHour: number;
  feeRate: number | null;
  occurredAt: string;
}

interface ScanSnapshot {
  id: string;
  mode: string;
  status: string;
  checkedSlots: number;
  changedSlots: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type SnapshotResponse = CompetitorSnapshotPayload & {
  days: Record<string, Record<string, CompetitorDaySnapshot>>;
  cancellations: CancellationSnapshot[];
  latestScan: ScanSnapshot | null;
};

interface ManualTableCell {
  sectionId: string;
  year: number;
  month: number;
  day: number;
  cellKey: string;
  value: string;
  color: string | null;
}

interface CompetitorManualCellData extends ManualCellData {
  hideAuto: boolean;
}

const HIDE_AUTO_COLOR = "__hide_auto__";
type LostSelection = "room1" | "room2" | "both" | "clear" | null;

const COMPETITORS: CompetitorSpace[] = [
  { id: "synergy", displayName: "시너지" },
  { id: "triground-a", displayName: "트라이그라운드 A" },
  { id: "triground-b", displayName: "트라이그라운드 B" },
];
const HOURS = Array.from({ length: 16 }, (_, index) => index + 8);
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
const FIRST_BUSINESS_YEAR = 2025;

function buildYearOptions(currentYear: number) {
  return Array.from(new Set([FIRST_BUSINESS_YEAR, currentYear, currentYear + 1]))
    .filter((year) => year >= FIRST_BUSINESS_YEAR)
    .sort((left, right) => left - right);
}

function manualCellKey(sectionId: string, day: Date, cellKey: string) {
  return `${sectionId}|${format(day, "yyyy-MM-dd")}|${cellKey}`;
}

function emptyCompetitorManualCell(): CompetitorManualCellData {
  return { ...emptyManualCell(), hideAuto: false };
}

interface BookingSegment {
  startHour: number;
  endHour: number;
  identity: string;
}

function dayBookingMetrics(
  competitorId: string,
  snapshot: CompetitorDaySnapshot | undefined,
  day: Date,
  manualCells: Record<string, CompetitorManualCellData>,
  cancellations: CancellationSnapshot[],
) {
  const segments: BookingSegment[] = [];
  const labels: Record<number, string> = {};

  for (const hour of HOURS) {
    const slot = snapshot?.slots[String(hour)];
    const manual = manualCells[manualCellKey(competitorId, day, `hour-${hour}`)];
    if (slot?.bookingNumber && !manual?.hideAuto) labels[hour] = String(slot.bookingNumber);

    let identity: string | null = null;
    if (manual?.color) {
      identity = `manual:${manual.color}`;
    } else if (slot?.state === "closed" && !manual?.hideAuto) {
      identity = `auto:${slot.bookingGroup || "baseline"}`;
    }
    if (!identity) continue;

    const previous = segments.at(-1);
    if (previous && previous.endHour + 1 === hour && previous.identity === identity) {
      previous.endHour = hour;
    } else {
      segments.push({ startHour: hour, endHour: hour, identity });
    }
  }

  const isTriground = competitorId === "triground-a" || competitorId === "triground-b";
  let billableHours = 0;
  let revenue = 0;
  for (const segment of segments) {
    const duration = segment.endHour - segment.startHour + 1;
    if (!isTriground) {
      billableHours += duration;
      continue;
    }
    if (duration === 1) continue;
    const price = duration * 12_000;
    billableHours += duration;
    revenue += price;
    labels[segment.endHour] = price.toLocaleString();
  }

  if (isTriground) {
    for (const cancellation of cancellations) {
      const duration = cancellation.endHour - cancellation.startHour;
      if (duration <= 1) continue;
      revenue += Math.round(duration * 12_000 * (cancellation.feeRate || 0) / 100);
    }
  }

  return { billableHours, revenue, labels };
}

function headerClass(competitorId: string) {
  if (competitorId === "synergy") return "bg-violet-50 text-violet-950";
  if (competitorId === "triground-a") return "bg-emerald-50 text-emerald-950";
  return "bg-sky-50 text-sky-950";
}

function lostLabel(rooms: string[]) {
  const room1 = rooms.includes("머무룸1");
  const room2 = rooms.includes("머무룸2");
  if (room1 && room2) return { short: "3·4", full: "3·4층 모두 놓침" };
  if (room1) return { short: "3", full: "3층 놓침" };
  if (room2) return { short: "4", full: "4층 놓침" };
  return null;
}

function manualLostRooms(value?: string) {
  if (value === "room1") return ["머무룸1"];
  if (value === "room2") return ["머무룸2"];
  if (value === "both") return ["머무룸1", "머무룸2"];
  return [];
}

function slotStatusLabel(slot: SlotSnapshot | undefined) {
  if (slot?.state === "need_check") return "확인";
  return "";
}

function slotClass(slot: SlotSnapshot | undefined, isWeekend: boolean) {
  if (slot?.state === "closed") {
    return isWeekend ? "bg-[#FCE4D6] text-slate-950" : "bg-[#DDEBF7] text-slate-950";
  }
  if (slot?.state === "policy_closed") return "bg-slate-100 text-slate-400";
  if (slot?.state === "need_check") return "bg-rose-100 text-rose-700";
  return "bg-white text-slate-500";
}

function cancellationAtHour(cancellations: CancellationSnapshot[], hour: number) {
  return cancellations.findLast((event) => hour >= event.startHour && hour < event.endHour);
}

function cancellationCellLabel(cancellation: CancellationSnapshot, hour: number) {
  const feeRate = `${cancellation.feeRate ?? 0}%`;
  const isStart = hour === cancellation.startHour;
  const isEnd = hour === cancellation.endHour - 1;
  if (isStart && isEnd) return `취소 ${feeRate}`;
  if (isStart) return "취소";
  if (isEnd) return feeRate;
  return "";
}

function scanStatusLabel(scan: ScanSnapshot | null) {
  if (!scan) return "아직 자동 확인 기록이 없습니다.";
  const at = scan.finishedAt || scan.startedAt;
  if (scan.status === "COMPLETED") return `최근 확인 ${format(new Date(at), "MM.dd HH:mm")} · 정상`;
  if (scan.status === "PARTIAL") return `최근 확인 ${format(new Date(at), "MM.dd HH:mm")} · 일부 확인 필요`;
  if (scan.status === "RUNNING") return "경쟁사 일정을 확인하고 있습니다.";
  return `최근 확인 실패 · ${scan.error || "공개 예약 화면을 읽지 못했습니다."}`;
}

export default function CompetitorsView({ initialSnapshots }: { initialSnapshots: CompetitorSnapshotPayload }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [competitorFilter, setCompetitorFilter] = useState<"all" | string>("all");
  const [manualCells, setManualCells] = useState<Record<string, CompetitorManualCellData>>({});
  const [savedManualCells, setSavedManualCells] = useState<Record<string, CompetitorManualCellData>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [snapshots, setSnapshots] = useState<SnapshotResponse>(initialSnapshots as SnapshotResponse);
  const [paintSelection, setPaintSelection] = useState<PaintSelection>(null);
  const [lostSelection, setLostSelection] = useState<LostSelection>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  const yearOptions = buildYearOptions(currentYear);
  const monthDays = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(currentDate), end: endOfMonth(currentDate) }),
    [currentDate],
  );
  const visibleCompetitors = competitorFilter === "all"
    ? COMPETITORS
    : COMPETITORS.filter((competitor) => competitor.id === competitorFilter);

  const fetchManualCells = useCallback(async (year: number, month: number) => {
    const response = await fetch(`/api/manual-table-cells?tableId=competitors&year=${year}&month=${month}`);
    if (!response.ok) throw new Error("수동 입력 정보를 불러오지 못했습니다.");
    const cells = (await response.json()) as ManualTableCell[];
    const loadedCells = cells.reduce<Record<string, CompetitorManualCellData>>((result, cell) => {
      const day = new Date(cell.year, cell.month - 1, cell.day);
      result[manualCellKey(cell.sectionId, day, cell.cellKey)] = {
        value: cell.value,
        color: cell.color === HIDE_AUTO_COLOR ? null : cell.color as ManualCellData["color"],
        hideAuto: cell.color === HIDE_AUTO_COLOR,
      };
      return result;
    }, {});
    setManualCells(loadedCells);
    setSavedManualCells(loadedCells);
    setDirtyKeys(new Set());
  }, []);

  const fetchSnapshots = useCallback(async (year: number, month: number) => {
    const response = await fetch(`/api/competitors/snapshots?year=${year}&month=${month}`, { cache: "no-store" });
    if (!response.ok) throw new Error("경쟁사 자동 확인 정보를 불러오지 못했습니다.");
    setSnapshots(await response.json() as SnapshotResponse);
  }, []);

  const loadMonth = useCallback(async (year: number, month: number) => {
    setLoadError(null);
    try {
      await Promise.all([fetchManualCells(year, month), fetchSnapshots(year, month)]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "경쟁사 현황을 불러오지 못했습니다.");
    }
  }, [fetchManualCells, fetchSnapshots]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMonth(currentYear, currentMonth);
  }, [currentMonth, currentYear, loadMonth]);

  const moveToMonth = (year: number, month: number) => setCurrentDate(new Date(year, month - 1, 1));
  const moveMonthBy = (amount: number) => {
    setCurrentDate((previous) => new Date(previous.getFullYear(), previous.getMonth() + amount, 1));
  };

  const updateManualCell = (sectionId: string, day: Date, cellKey: string, patch: Partial<CompetitorManualCellData>) => {
    const key = manualCellKey(sectionId, day, cellKey);
    setManualCells((previous) => ({
      ...previous,
      [key]: { ...emptyCompetitorManualCell(), ...previous[key], ...patch },
    }));
    setDirtyKeys((previous) => new Set(previous).add(key));
  };

  const saveManualCell = async (sectionId: string, day: Date, cellKey: string, cell: CompetitorManualCellData) => {
    const response = await fetch("/api/manual-table-cells", {
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
        color: cell.hideAuto ? HIDE_AUTO_COLOR : cell.color,
      }),
    });
    if (!response.ok) throw new Error("수동 입력을 저장하지 못했습니다.");
  };

  const applyPaintToCell = (sectionId: string, day: Date, cellKey: string, hasAutoRecord: boolean) => {
    if (paintSelection === null) return;
    const key = manualCellKey(sectionId, day, cellKey);
    const currentCell = manualCells[key] || emptyCompetitorManualCell();
    const nextCell: CompetitorManualCellData = paintSelection === "clear" && hasAutoRecord
      ? { ...currentCell, color: null, hideAuto: !currentCell.hideAuto }
      : {
          ...currentCell,
          color: paintSelection === "clear" ? null : paintSelection,
          hideAuto: paintSelection === "clear" ? currentCell.hideAuto : false,
        };
    updateManualCell(sectionId, day, cellKey, nextCell);
    if (paintSelection === "clear" && hasAutoRecord) {
      setEditMessage(nextCell.hideAuto
        ? "자동 기록을 지웠습니다. 시간 합계에 즉시 반영됐으며, 저장을 눌러 확정하세요."
        : "자동 기록을 복원했습니다. 저장을 눌러 확정하세요.");
    }
  };

  const applyLostToCell = (day: Date, hour: number, hasBooking: boolean) => {
    if (lostSelection === null) return;
    if (lostSelection !== "clear" && !hasBooking) {
      setEditMessage("먼저 예약 시간을 색으로 표시한 뒤, 예약 시작 칸에 놓침 표시를 추가하세요.");
      return;
    }

    const cellKey = `lost-hour-${hour}`;
    const value = lostSelection === "clear" ? "" : lostSelection;
    updateManualCell("synergy", day, cellKey, { value, color: null, hideAuto: false });
    setEditMessage(lostSelection === "clear"
      ? "수동 놓침 표시를 지웠습니다. 저장을 눌러 확정하세요."
      : "수동 놓침 표시를 추가했습니다. 저장을 눌러 확정하세요.");
  };

  const undoChanges = () => {
    setManualCells(savedManualCells);
    setDirtyKeys(new Set());
    setEditMessage("저장 전 변경사항을 되돌렸습니다.");
    setLoadError(null);
  };

  const saveChanges = async () => {
    if (dirtyKeys.size === 0 || isSaving) return;
    setIsSaving(true);
    setLoadError(null);
    const draft = manualCells;
    const keysToSave = [...dirtyKeys];
    try {
      await Promise.all(keysToSave.map(async (key) => {
        const [sectionId, dateKey, cellKey] = key.split("|");
        const day = new Date(`${dateKey}T00:00:00`);
        await saveManualCell(sectionId, day, cellKey, draft[key] || emptyCompetitorManualCell());
      }));
      setSavedManualCells(draft);
      setDirtyKeys(new Set());
      setEditMessage("저장되었습니다.");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "변경사항을 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  const runScan = async () => {
    setIsRefreshing(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/competitors/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "daily" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "경쟁사 일정 확인에 실패했습니다.");
      }
      await loadMonth(currentYear, currentMonth);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "경쟁사 일정 확인에 실패했습니다.");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1680px] space-y-6 p-4 pb-24 md:p-8">
      <header className="flex flex-col gap-4 pb-2 pt-8 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">경쟁사 현황</h1>
          <p className="mt-1 text-sm text-slate-500">공개 예약 상태를 자동으로 기록하고, 시너지 선점 여부를 함께 확인합니다.</p>
          <p className={cn("mt-2 text-xs font-bold", snapshots.latestScan?.status === "FAILED" ? "text-rose-600" : "text-slate-500")}>
            {scanStatusLabel(snapshots.latestScan)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => moveMonthBy(-1)} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600">
            <ChevronLeft className="h-4 w-4" />이전
          </button>
          <button onClick={() => moveMonthBy(1)} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600">
            다음<ChevronRight className="h-4 w-4" />
          </button>
          <button onClick={runScan} disabled={isRefreshing} className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-2 text-sm font-bold text-white disabled:bg-slate-400">
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            {isRefreshing ? "확인 중" : "지금 확인"}
          </button>
        </div>
      </header>

      {loadError && <div className="border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{loadError}</div>}

      <section className="space-y-4 border-y border-slate-200 bg-white py-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[140px_minmax(0,1fr)_360px]">
          <label className="space-y-1.5 text-xs font-black text-slate-500">
            연도
            <select value={currentYear} onChange={(event) => moveToMonth(Number(event.target.value), currentMonth)} className="block w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700">
              {yearOptions.map((year) => <option key={year} value={year}>{year}년</option>)}
            </select>
          </label>
          <div className="space-y-1.5">
            <p className="text-xs font-black text-slate-500">월</p>
            <div className="grid grid-cols-6 gap-1.5 md:grid-cols-12">
              {MONTHS.map((month) => (
                <button key={month} onClick={() => moveToMonth(currentYear, month)} className={cn("h-10 rounded border text-sm font-black", currentMonth === month ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600")}>
                  {month}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-black text-slate-500">경쟁사</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(["all", ...COMPETITORS.map((competitor) => competitor.id)] as const).map((id) => {
                const label = id === "all" ? "전체" : COMPETITORS.find((competitor) => competitor.id === id)?.displayName;
                return <button key={id} onClick={() => setCompetitorFilter(id)} className={cn("h-10 rounded border px-2 text-xs font-black", competitorFilter === id ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600")}>{label}</button>;
              })}
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TablePaintToolbar
              selected={paintSelection}
              onSelect={(selection) => {
                setPaintSelection(selection);
                setLostSelection(null);
              }}
              showColorLabels
              clearLabel="색·자동 기록 지우기"
              clearTitle="자동 기록이 있는 칸은 삭제하며, 저장 전에는 되돌릴 수 있습니다."
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
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-black text-slate-600">시너지 놓침 표시</span>
            {([
              ["room1", "3층 놓침"],
              ["room2", "4층 놓침"],
              ["both", "3·4층 놓침"],
              ["clear", "표시 지우기"],
            ] as const).map(([selection, label]) => (
              <button
                key={selection}
                type="button"
                aria-pressed={lostSelection === selection}
                onClick={() => {
                  setLostSelection(selection);
                  setPaintSelection(null);
                }}
                className={cn(
                  "h-8 rounded border px-2.5 text-[11px] font-black transition active:scale-95",
                  lostSelection === selection
                    ? selection === "clear"
                      ? "border-slate-700 bg-slate-700 text-white"
                      : "border-red-600 bg-red-600 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {label}
              </button>
            ))}
            <span className="ml-1 text-[11px] font-semibold text-slate-400">예약 시작 칸을 누르세요.</span>
          </div>
          {editMessage && <p className="mt-2 text-xs font-bold text-slate-500">{editMessage}</p>}
        </div>
      </section>

      <div className="space-y-6">
        {visibleCompetitors.map((competitor) => {
          const competitorDays = snapshots.days[competitor.id] || {};
          const monthMetrics = monthDays.reduce((total, date) => {
            const dateKey = format(date, "yyyy-MM-dd");
            const day = competitorDays[dateKey];
            const cancellations = snapshots.cancellations.filter((event) => event.competitorId === competitor.id && event.dateKey === dateKey);
            const metrics = dayBookingMetrics(competitor.id, day, date, manualCells, cancellations);
            return {
              billableHours: total.billableHours + metrics.billableHours,
              revenue: total.revenue + metrics.revenue,
            };
          }, { billableHours: 0, revenue: 0 });
          const isTriground = competitor.id === "triground-a" || competitor.id === "triground-b";
          return (
            <section key={competitor.id} className="overflow-hidden border border-slate-300 bg-white">
              <div className={cn("border-b border-slate-300 px-4 py-2 text-center text-sm font-black", headerClass(competitor.id))}>{competitor.displayName}</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1500px] table-fixed border-collapse text-[11px]">
                  <thead><tr className="h-7 bg-emerald-50 text-slate-900">
                    <th className="sticky left-0 z-20 w-[92px] border border-slate-300 bg-emerald-50 text-center">날짜</th>
                    <th className="sticky left-[92px] z-20 w-[72px] border border-slate-300 bg-emerald-50 text-center">시간 합계</th>
                    {HOURS.map((hour) => <th key={hour} className="w-[66px] border border-slate-300 text-center">{hour}</th>)}
                    <th className="sticky right-0 z-20 w-[190px] border border-slate-300 bg-emerald-50 text-center">확인·변경</th>
                  </tr></thead>
                  <tbody>
                    {monthDays.map((day) => {
                      const dateKey = format(day, "yyyy-MM-dd");
                      const snapshot = competitorDays[dateKey];
                      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                      const pendingCount = snapshot ? Object.values(snapshot.slots).filter((slot) => slot.cancellationPending).length : 0;
                      const cancellations = snapshots.cancellations.filter((event) => event.competitorId === competitor.id && event.dateKey === dateKey);
                      const metrics = dayBookingMetrics(competitor.id, snapshot, day, manualCells, cancellations);
                      const noteParts = [
                        snapshot?.checkedAt ? `확인 ${format(new Date(snapshot.checkedAt), "HH:mm")}` : null,
                        pendingCount > 0 ? `취소 재확인 ${pendingCount}칸` : null,
                        ...cancellations.map((event) => `취소 ${event.startHour}~${event.endHour}시 · 수수료 ${event.feeRate ?? 0}%`),
                      ].filter(Boolean);
                      return (
                        <tr key={`${competitor.id}-${dateKey}`} className="group h-7">
                          <td className={cn("sticky left-0 z-10 border border-slate-300 bg-white px-1 text-center font-semibold group-hover:bg-slate-50", isWeekend && "text-red-500")}>{format(day, "MM월 dd일")}</td>
                          <td className="sticky left-[92px] z-10 border border-slate-300 bg-white text-center font-bold text-slate-700 group-hover:bg-slate-50">{metrics.billableHours || "-"}</td>
                          {HOURS.map((hour) => {
                            const slot = snapshot?.slots[String(hour)];
                            const cancellation = cancellationAtHour(cancellations, hour);
                            const editableKey = `hour-${hour}`;
                            const key = manualCellKey(competitor.id, day, editableKey);
                            const manualCell = manualCells[key] || emptyCompetitorManualCell();
                            const manualClass = manualColorClass(manualCell.color);
                            const visibleSlot = manualCell.hideAuto ? undefined : slot;
                            const visibleCancellation = manualCell.hideAuto ? undefined : cancellation;
                            const showCancellation = Boolean(
                              visibleCancellation
                              && visibleSlot?.state !== "closed"
                              && !manualClass,
                            );
                            const hasAutoRecord = Boolean(
                              cancellation || (slot && !["available", "not_collected"].includes(slot.state)),
                            );
                            const manualLostCell = manualCells[manualCellKey(competitor.id, day, `lost-hour-${hour}`)];
                            const manualLost = manualLostRooms(manualLostCell?.value);
                            const opportunity = competitor.id === "synergy"
                              ? lostLabel(manualLost.length > 0 ? manualLost : visibleSlot?.opportunityLostRooms || [])
                              : null;
                            const hasBooking = Boolean(manualClass || visibleSlot?.state === "closed");
                            const isLostEditing = competitor.id === "synergy" && lostSelection !== null;
                            const cancellationLabel = showCancellation && visibleCancellation
                              ? cancellationCellLabel(visibleCancellation, hour)
                              : "";
                            return (
                              <td
                                key={`${dateKey}-${hour}`}
                                title={showCancellation && visibleCancellation
                                  ? `취소 ${visibleCancellation.startHour}~${visibleCancellation.endHour}시 · 수수료 ${visibleCancellation.feeRate ?? 0}%`
                                  : undefined}
                                onMouseDown={(event) => {
                                  if (paintSelection !== null) {
                                    event.preventDefault();
                                    applyPaintToCell(competitor.id, day, editableKey, hasAutoRecord);
                                  }
                                }}
                                className={cn(
                                  "relative h-7 border border-slate-300 p-0 text-center align-middle font-semibold",
                                  manualClass || (showCancellation ? "bg-[#BFBFBF] text-slate-950" : slotClass(visibleSlot, isWeekend)),
                                  visibleSlot?.bookingNumber && "border-l-2 border-l-slate-700",
                                  (paintSelection !== null || isLostEditing) && "cursor-crosshair",
                                )}
                              >
                                {isLostEditing && (
                                  <button
                                    type="button"
                                    aria-label={`시너지 ${format(day, "MM월 dd일")} ${hour}시 놓침 표시 적용`}
                                    title="선택한 놓침 표시 적용"
                                    onClick={() => applyLostToCell(day, hour, hasBooking)}
                                    className="absolute inset-0 z-20 cursor-crosshair bg-transparent"
                                  />
                                )}
                                <EditableTableCellInput
                                  ariaLabel={`${competitor.displayName} ${format(day, "MM월 dd일")} ${hour}시 수동 입력`}
                                  value={manualCell.value}
                                  placeholder={cancellationLabel || metrics.labels[hour] || slotStatusLabel(visibleSlot)}
                                  disabled={paintSelection !== null || isLostEditing}
                                  onChange={(value) => updateManualCell(competitor.id, day, editableKey, { value })}
                                  onCommit={(value) => updateManualCell(competitor.id, day, editableKey, { value })}
                                  className={cn(
                                    "text-center",
                                    opportunity && "pr-5",
                                    (paintSelection !== null || isLostEditing) && "pointer-events-none",
                                  )}
                                />
                                {opportunity && <span title={`${opportunity.full}${manualLost.length > 0 ? " (수동)" : ""}`} aria-label={`${opportunity.full}${manualLost.length > 0 ? " 수동 표시" : ""}`} className="absolute right-0.5 top-0.5 z-10 rounded-sm bg-red-600 px-1 text-[9px] font-black leading-4 text-white">{opportunity.short}✓</span>}
                              </td>
                            );
                          })}
                          <td className={cn("sticky right-0 z-10 border border-slate-300 bg-white px-1 text-center text-[10px] font-semibold text-slate-600 group-hover:bg-slate-50", pendingCount > 0 && "text-amber-700")}>{noteParts.join(" / ") || "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr className="h-7 bg-slate-100 font-black text-slate-900">
                    <td className="sticky left-0 z-20 border border-slate-400 bg-slate-100 text-center">월 총합</td>
                    <td className="sticky left-[92px] z-20 border border-slate-400 bg-slate-100 text-center">{monthMetrics.billableHours}</td>
                    <td colSpan={2} className="border border-slate-400 bg-slate-100 text-center tabular-nums">{isTriground ? `${monthMetrics.revenue.toLocaleString()}원` : ""}</td>
                    <td colSpan={HOURS.length - 2} className="border border-slate-400 bg-slate-100 text-center">{isTriground ? "유료 예약 시간 합계" : "예약 확인 시간 합계"}</td>
                    <td className="sticky right-0 z-20 border border-slate-400 bg-slate-100 text-center">자동 기록</td>
                  </tr></tfoot>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
