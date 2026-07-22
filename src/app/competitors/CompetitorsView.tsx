"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { eachDayOfInterval, endOfMonth, format, startOfMonth } from "date-fns";
import Image from "next/image";
import { Camera, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Maximize2, RefreshCw, Save, Undo2, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { CompetitorSnapshotPayload } from "@/lib/competitor-snapshots";
import {
  cancellationDetectedDateLabel,
  cancellationEquivalentHours,
} from "@/lib/competitor-cancellation";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";

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
  firstDetectedAt: string | null;
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

interface UnreadEventSnapshot {
  id: string;
  eventIds: string[];
  competitorId: string;
  dateKey: string;
  eventType: "BOOKED" | "CANCELLED";
  startHour: number;
  endHour: number;
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

interface EvidenceSnapshot {
  id: string;
  competitorId: string;
  dateKey: string | null;
  startHour: number | null;
  endHour: number | null;
  reasonCode: string;
  reason: string;
  status: "OPEN" | "RESOLVED" | string;
  capturedAt: string;
  lastSeenAt: string;
  imageUrl: string;
}

type SnapshotResponse = CompetitorSnapshotPayload & {
  days: Record<string, Record<string, CompetitorDaySnapshot>>;
  cancellations: CancellationSnapshot[];
  unreadEvents: UnreadEventSnapshot[];
  evidence: EvidenceSnapshot[];
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

const HIDE_AUTO_COLOR = "__hide_auto__";
const MANUAL_CANCELLATION_COLOR = "__cancelled__";

interface CompetitorManualCellData extends Omit<ManualCellData, "color"> {
  color: ManualCellData["color"] | typeof MANUAL_CANCELLATION_COLOR;
  hideAuto: boolean;
}

type LostSelection = "room1" | "room2" | "both" | "clear" | null;
interface CancellationRangeStart {
  competitorId: string;
  dateKey: string;
  hour: number;
}

const COMPETITORS: CompetitorSpace[] = [
  { id: "synergy", displayName: "시너지" },
  { id: "triground-a", displayName: "트라이그라운드 A" },
  { id: "triground-b", displayName: "트라이그라운드 B" },
];
const HOURS = Array.from({ length: 17 }, (_, index) => index + 8);
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

function manualCellKeyFromParts(sectionId: string, year: number, month: number, day: number, cellKey: string) {
  return `${sectionId}|${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}|${cellKey}`;
}

function emptyCompetitorManualCell(): CompetitorManualCellData {
  return { ...emptyManualCell(), hideAuto: false };
}

function competitorManualCellEquals(left: CompetitorManualCellData, right: CompetitorManualCellData) {
  return manualCellDataEquals(left, right) && left.hideAuto === right.hideAuto;
}

function mapManualCells(cells: ManualTableCell[]) {
  return cells.reduce<Record<string, CompetitorManualCellData>>((result, cell) => {
    result[manualCellKeyFromParts(cell.sectionId, cell.year, cell.month, cell.day, cell.cellKey)] = {
      value: cell.value,
      color: cell.color === HIDE_AUTO_COLOR ? null : cell.color as CompetitorManualCellData["color"],
      hideAuto: cell.color === HIDE_AUTO_COLOR,
    };
    return result;
  }, {});
}

interface BookingSegment {
  startHour: number;
  endHour: number;
  identity: string;
  firstDetectedAt: string | null;
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
  const firstDetectedLabels: Record<number, string> = {};

  for (const hour of HOURS) {
    const slot = snapshot?.slots[String(hour)];
    const manual = manualCells[manualCellKey(competitorId, day, `hour-${hour}`)];
    if (slot?.bookingNumber && !manual?.hideAuto) labels[hour] = String(slot.bookingNumber);

    let identity: string | null = null;
    if (manual?.color === MANUAL_CANCELLATION_COLOR) {
      identity = null;
    } else if (manual?.color) {
      identity = `manual:${manual.color}`;
    } else if (slot?.state === "closed" && !manual?.hideAuto) {
      identity = `auto:${slot.bookingGroup || "baseline"}`;
    }
    if (!identity) continue;

    const previous = segments.at(-1);
    if (previous && previous.endHour + 1 === hour && previous.identity === identity) {
      previous.endHour = hour;
    } else {
      segments.push({
        startHour: hour,
        endHour: hour,
        identity,
        firstDetectedAt: identity.startsWith("auto:") ? slot?.firstDetectedAt || null : null,
      });
    }
  }

  const isTriground = competitorId === "triground-a" || competitorId === "triground-b";
  let billableHours = 0;
  let revenue = 0;
  for (const segment of segments) {
    const duration = segment.endHour - segment.startHour + 1;
    if (segment.firstDetectedAt) {
      const labelHour = segment.startHour + Math.floor(duration / 2);
      firstDetectedLabels[labelHour] = format(new Date(segment.firstDetectedAt), "MM.dd");
    }
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

  for (const cancellation of cancellations) {
    const duration = cancellation.endHour - cancellation.startHour;
    // 무료 1시간 예약은 감지 단계에서 수수료율 0%로 저장되어 이 목록에서
    // 제외된다. 여기 들어온 취소는 원래 2시간 이상 예약의 일부 취소일 수도
    // 있으므로 감지 단계에서 확정한 수수료율을 그대로 사용한다.
    const feeRate = cancellation.feeRate;
    billableHours += cancellationEquivalentHours(duration, feeRate);
    if (isTriground && duration > 1) {
      revenue += Math.round(duration * 12_000 * (feeRate || 0) / 100);
    }
  }

  return { billableHours, revenue, labels, firstDetectedLabels };
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
  const detectedDate = cancellationDetectedDateLabel(cancellation.occurredAt);
  const isStart = hour === cancellation.startHour;
  const isEnd = hour === cancellation.endHour - 1;
  if (isStart && isEnd) return `취소 ${detectedDate}`;
  if (isStart) return `취소 ${detectedDate}`;
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

function competitorDisplayName(competitorId: string) {
  return COMPETITORS.find((competitor) => competitor.id === competitorId)?.displayName || competitorId;
}

function evidenceTimeLabel(evidence: EvidenceSnapshot) {
  if (evidence.startHour === null || evidence.endHour === null) return "시간 확인 필요";
  return `${String(evidence.startHour).padStart(2, "0")}:00-${String(evidence.endHour).padStart(2, "0")}:00`;
}

export default function CompetitorsView({
  initialSnapshots,
  initialManualCells,
}: {
  initialSnapshots: CompetitorSnapshotPayload;
  initialManualCells: ManualTableCell[];
}) {
  const controlsRef = useRef<HTMLElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [competitorFilter, setCompetitorFilter] = useState<"all" | string>("all");
  const [manualCells, setManualCells] = useState<Record<string, CompetitorManualCellData>>(
    () => mapManualCells(initialManualCells),
  );
  const [savedManualCells, setSavedManualCells] = useState<Record<string, CompetitorManualCellData>>(
    () => mapManualCells(initialManualCells),
  );
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [snapshots, setSnapshots] = useState<SnapshotResponse>(initialSnapshots as SnapshotResponse);
  const [paintSelection, setPaintSelection] = useState<PaintSelection>(null);
  const [isCancellationPaint, setIsCancellationPaint] = useState(false);
  const [cancellationRangeStart, setCancellationRangeStart] = useState<CancellationRangeStart | null>(null);
  const [lostSelection, setLostSelection] = useState<LostSelection>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceSnapshot | null>(null);
  const [dismissingEvidenceId, setDismissingEvidenceId] = useState<string | null>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const updateHeight = () => setControlsHeight(Math.ceil(controls.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(controls);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

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
  const unreadEvents = snapshots.unreadEvents || [];
  const unreadBookings = unreadEvents.filter((event) => event.eventType === "BOOKED");
  const unreadCancellations = unreadEvents.filter((event) => event.eventType === "CANCELLED");
  const evidence = snapshots.evidence || [];
  const layoutStyle = {
    "--competitor-header-top": competitorFilter === "all" ? "0px" : `${controlsHeight + 8}px`,
  } as CSSProperties;

  const requestManualCells = useCallback(async (year: number, month: number) => {
    const response = await fetch(`/api/manual-table-cells?tableId=competitors&year=${year}&month=${month}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("수동 입력 정보를 불러오지 못했습니다.");
    const cells = (await response.json()) as ManualTableCell[];
    return mapManualCells(cells);
  }, []);

  const fetchManualCells = useCallback(async (year: number, month: number) => {
    const loadedCells = await requestManualCells(year, month);
    setManualCells(loadedCells);
    setSavedManualCells(loadedCells);
    setDirtyKeys(new Set());
  }, [requestManualCells]);

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

  useDataChangePolling(
    `/api/data-version?scope=competitors&year=${currentYear}&month=${currentMonth}`,
    async () => {
      try {
        const updates: Promise<void>[] = [fetchSnapshots(currentYear, currentMonth)];
        if (dirtyKeys.size === 0) updates.push(fetchManualCells(currentYear, currentMonth));
        await Promise.all(updates);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "경쟁사 자동 확인 정보를 갱신하지 못했습니다.");
      }
    },
  );

  const canLeaveCurrentMonth = () => {
    if (dirtyKeys.size === 0) return true;
    setEditMessage("저장하지 않은 수동 입력이 있습니다. 저장하거나 되돌린 뒤 월을 이동해 주세요.");
    return false;
  };
  const moveToMonth = (year: number, month: number) => {
    if (!canLeaveCurrentMonth()) return;
    setCurrentDate(new Date(year, month - 1, 1));
  };
  const moveToUnreadEvent = (event: UnreadEventSnapshot) => {
    const [year, month] = event.dateKey.split("-").map(Number);
    moveToMonth(year, month);
    setCompetitorFilter(event.competitorId);
  };
  const moveMonthBy = (amount: number) => {
    if (!canLeaveCurrentMonth()) return;
    setCurrentDate((previous) => new Date(previous.getFullYear(), previous.getMonth() + amount, 1));
  };

  const updateManualCell = (sectionId: string, day: Date, cellKey: string, patch: Partial<CompetitorManualCellData>) => {
    const key = manualCellKey(sectionId, day, cellKey);
    const currentCell = { ...emptyCompetitorManualCell(), ...manualCells[key] };
    const nextCell = { ...currentCell, ...patch };
    const savedCell = { ...emptyCompetitorManualCell(), ...savedManualCells[key] };
    const changedFromCurrent = !competitorManualCellEquals(currentCell, nextCell);
    const changedFromSaved = !competitorManualCellEquals(savedCell, nextCell);

    if (changedFromCurrent) {
      setManualCells((previous) => ({
        ...previous,
        [key]: nextCell,
      }));
    }
    setDirtyKeys((previous) => reconcileDirtyKey(previous, key, changedFromSaved));
  };

  const saveManualCell = async (
    sectionId: string,
    day: Date,
    cellKey: string,
    cell: CompetitorManualCellData,
    year: number,
    month: number,
  ) => {
    const response = await fetch("/api/manual-table-cells", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableId: "competitors",
        sectionId,
        year,
        month,
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

  const applyCancellationRange = (competitorId: string, day: Date, hour: number) => {
    const dateKey = format(day, "yyyy-MM-dd");
    if (!cancellationRangeStart
      || cancellationRangeStart.competitorId !== competitorId
      || cancellationRangeStart.dateKey !== dateKey) {
      setCancellationRangeStart({ competitorId, dateKey, hour });
      setEditMessage(`${hour}시를 취소 예약 시작으로 선택했습니다. 마지막 사용 시간 칸을 누르세요.`);
      return;
    }

    const startHour = Math.min(cancellationRangeStart.hour, hour);
    const endHour = Math.max(cancellationRangeStart.hour, hour);
    const changedKeys = Array.from(
      { length: endHour - startHour + 1 },
      (_, index) => manualCellKey(competitorId, day, `hour-${startHour + index}`),
    );
    const nextCells = new Map<string, CompetitorManualCellData>();
    for (let targetHour = startHour; targetHour <= endHour; targetHour += 1) {
      const key = manualCellKey(competitorId, day, `hour-${targetHour}`);
      nextCells.set(key, {
        ...emptyCompetitorManualCell(),
        ...manualCells[key],
        value: targetHour === startHour ? "취소" : "",
        color: MANUAL_CANCELLATION_COLOR,
        hideAuto: false,
      });
    }

    setManualCells((previous) => {
      const next = { ...previous };
      nextCells.forEach((cell, key) => { next[key] = cell; });
      return next;
    });
    setDirtyKeys((previous) => {
      let next = previous;
      changedKeys.forEach((key) => {
        const savedCell = { ...emptyCompetitorManualCell(), ...savedManualCells[key] };
        const nextCell = nextCells.get(key) || emptyCompetitorManualCell();
        next = reconcileDirtyKey(next, key, !competitorManualCellEquals(savedCell, nextCell));
      });
      return next;
    });
    setCancellationRangeStart(null);
    setEditMessage(`${startHour}시부터 ${endHour + 1}시까지 취소 예약 1건으로 표시했습니다. 저장을 눌러 확정하세요.`);
  };

  const applyLostToCell = (competitorId: string, day: Date, hour: number, hasBooking: boolean) => {
    if (lostSelection === null) return;
    if (lostSelection !== "clear" && !hasBooking) {
      setEditMessage("먼저 예약 시간을 색으로 표시한 뒤, 예약 시작 칸에 놓침 표시를 추가하세요.");
      return;
    }

    const cellKey = `lost-hour-${hour}`;
    const value = lostSelection === "clear" ? "" : lostSelection;
    updateManualCell(competitorId, day, cellKey, { value, color: null, hideAuto: false });
    setEditMessage(lostSelection === "clear"
      ? "수동 놓침 표시를 지웠습니다. 저장을 눌러 확정하세요."
      : "수동 놓침 표시를 추가했습니다. 저장을 눌러 확정하세요.");
  };

  const undoChanges = () => {
    setManualCells(savedManualCells);
    setDirtyKeys(new Set());
    setCancellationRangeStart(null);
    setEditMessage("저장 전 변경사항을 되돌렸습니다.");
    setLoadError(null);
  };

  const saveChanges = async () => {
    if (dirtyKeys.size === 0 || isSaving) return;
    setIsSaving(true);
    setLoadError(null);
    const draft = manualCells;
    const keysToSave = [...dirtyKeys];
    const savingYear = currentYear;
    const savingMonth = currentMonth;
    try {
      for (const key of keysToSave) {
        const [sectionId, dateKey, cellKey] = key.split("|");
        const day = new Date(`${dateKey}T12:00:00`);
        await saveManualCell(
          sectionId,
          day,
          cellKey,
          draft[key] || emptyCompetitorManualCell(),
          savingYear,
          savingMonth,
        );
      }

      const verifiedCells = await requestManualCells(savingYear, savingMonth);
      const mismatched = keysToSave.some((key) => {
        const expected = draft[key] || emptyCompetitorManualCell();
        const actual = verifiedCells[key] || emptyCompetitorManualCell();
        return expected.value.trim() !== actual.value
          || expected.color !== actual.color
          || expected.hideAuto !== actual.hideAuto;
      });
      if (mismatched) throw new Error("저장값 확인에 실패했습니다. 변경사항은 화면에 그대로 유지됩니다.");

      setManualCells(verifiedCells);
      setSavedManualCells(verifiedCells);
      setDirtyKeys(new Set());
      setCancellationRangeStart(null);
      setEditMessage("저장되었습니다.");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "변경사항을 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  const acknowledgeEvents = async (eventIds: string[]) => {
    if (eventIds.length === 0 || isAcknowledging) return;
    setIsAcknowledging(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/competitors/events/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventIds }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "신규 경쟁사 예약 확인에 실패했습니다.");
      }

      const acknowledgedIds = new Set(eventIds);
      setSnapshots((previous) => ({
        ...previous,
        unreadEvents: previous.unreadEvents.filter((event) => (
          !event.eventIds.some((eventId) => acknowledgedIds.has(eventId))
        )),
      }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "신규 경쟁사 예약 확인에 실패했습니다.");
    } finally {
      setIsAcknowledging(false);
    }
  };

  const dismissEvidence = async (evidenceId: string) => {
    if (dismissingEvidenceId) return;
    setDismissingEvidenceId(evidenceId);
    setLoadError(null);
    try {
      const response = await fetch(`/api/competitors/evidence/${evidenceId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "확인 자료를 정리하지 못했습니다.");
      }
      setSnapshots((previous) => ({
        ...previous,
        evidence: (previous.evidence || []).filter((item) => item.id !== evidenceId),
      }));
      setSelectedEvidence((previous) => previous?.id === evidenceId ? null : previous);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "확인 자료를 정리하지 못했습니다.");
    } finally {
      setDismissingEvidenceId(null);
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
      const result = await response.json() as { status?: string; error?: string };
      if (result.status === "FAILED") {
        throw new Error(result.error || "경쟁사 공개 예약 화면을 읽지 못했습니다.");
      }
      // Refresh only automated snapshots. Reloading manual cells here would
      // silently discard any unsaved operator edits on the table.
      await fetchSnapshots(currentYear, currentMonth);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "경쟁사 일정 확인에 실패했습니다.");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 p-4 pb-24 md:p-8" style={layoutStyle}>
      <header className="flex flex-col gap-2 pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">경쟁사 현황</h1>
          <p className="mt-0.5 text-sm text-slate-500">공개 예약 상태를 자동으로 기록하고, 시너지 선점 여부를 함께 확인합니다.</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <p className={cn("text-xs font-bold", snapshots.latestScan?.status === "FAILED" ? "text-rose-600" : "text-slate-500")}>
            {scanStatusLabel(snapshots.latestScan)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => moveMonthBy(-1)} className="inline-flex h-9 items-center gap-1 rounded border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600">
              <ChevronLeft className="h-4 w-4" />이전
            </button>
            <button onClick={() => moveMonthBy(1)} className="inline-flex h-9 items-center gap-1 rounded border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600">
              다음<ChevronRight className="h-4 w-4" />
            </button>
            <button onClick={runScan} disabled={isRefreshing} className="inline-flex h-9 items-center gap-1.5 rounded bg-indigo-600 px-3 text-sm font-bold text-white disabled:bg-slate-400">
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              {isRefreshing ? "확인 중" : "지금 확인"}
            </button>
          </div>
        </div>
      </header>

      {loadError && <div className="border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{loadError}</div>}

      {unreadEvents.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs font-black">
            <span className="text-emerald-800">새 경쟁사 변동을 확인하세요.</span>
            {unreadBookings.length > 0 && (
              <button
                type="button"
                title="가장 먼저 확인하지 않은 신규 예약으로 이동"
                onClick={() => moveToUnreadEvent(unreadBookings[0])}
                className="rounded-full bg-emerald-600 px-2 py-1 text-white"
              >
                신규 예약 {unreadBookings.length}건
              </button>
            )}
            {unreadCancellations.length > 0 && (
              <button
                type="button"
                title="가장 먼저 확인하지 않은 신규 취소로 이동"
                onClick={() => moveToUnreadEvent(unreadCancellations[0])}
                className="rounded-full bg-rose-600 px-2 py-1 text-white"
              >
                신규 취소 {unreadCancellations.length}건
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={isAcknowledging}
            onClick={() => acknowledgeEvents(unreadEvents.flatMap((event) => event.eventIds))}
            className="h-8 rounded border border-emerald-300 bg-white px-3 text-xs font-black text-emerald-800 disabled:opacity-50"
          >
            {isAcknowledging ? "확인 중" : "모두 확인"}
          </button>
        </section>
      )}

      {evidence.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-amber-700" aria-hidden="true" />
              <h2 className="text-xs font-black text-amber-950">판단 확인 자료</h2>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-black text-amber-800">
                확인 필요 {evidence.filter((item) => item.status === "OPEN").length}건
              </span>
            </div>
            <p className="hidden text-[10px] font-semibold text-amber-800 sm:block">사진을 누르면 크게 볼 수 있습니다.</p>
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {evidence.map((item) => (
              <article
                key={item.id}
                className="relative flex min-w-[285px] max-w-[340px] flex-1 items-center gap-2 rounded-md border border-amber-200 bg-white p-2 pr-8"
              >
                <button
                  type="button"
                  onClick={() => setSelectedEvidence(item)}
                  className="group relative h-[62px] w-[104px] shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100"
                  aria-label={`${competitorDisplayName(item.competitorId)} 확인 화면 확대`}
                >
                  <Image
                    src={item.imageUrl}
                    alt={`${competitorDisplayName(item.competitorId)} 자동 확인 화면`}
                    width={208}
                    height={124}
                    unoptimized
                    className="h-full w-full object-cover object-top"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-slate-950/0 transition group-hover:bg-slate-950/30">
                    <Maximize2 className="h-4 w-4 text-transparent transition group-hover:text-white" aria-hidden="true" />
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-xs font-black text-slate-900">{competitorDisplayName(item.competitorId)}</p>
                    {item.status === "RESOLVED" && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-black text-emerald-700">
                        <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />해결됨
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] font-bold text-slate-500">
                    {item.dateKey || "날짜 확인 필요"} · {evidenceTimeLabel(item)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[10px] font-semibold leading-4 text-slate-700">{item.reason}</p>
                  <p className="mt-0.5 text-[9px] font-semibold text-slate-400">{format(new Date(item.capturedAt), "MM.dd HH:mm")} 캡처</p>
                </div>
                <button
                  type="button"
                  onClick={() => void dismissEvidence(item.id)}
                  disabled={dismissingEvidenceId === item.id}
                  className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                  aria-label="확인 자료 정리"
                  title="목록에서 지우기"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <section
        ref={controlsRef}
        className={cn(
          "space-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm",
          competitorFilter !== "all" && "z-40 bg-white/95 backdrop-blur xl:sticky xl:top-0 xl:max-h-[calc(100vh-1rem)] xl:overflow-y-auto",
        )}
      >
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[120px_minmax(0,1fr)_320px] xl:grid-cols-[128px_minmax(0,1fr)_340px]">
          <label className="space-y-1 text-xs font-black text-slate-500">
            연도
            <select value={currentYear} onChange={(event) => moveToMonth(Number(event.target.value), currentMonth)} className="block h-8 w-full rounded border border-slate-200 bg-white px-3 text-sm text-slate-700">
              {yearOptions.map((year) => <option key={year} value={year}>{year}년</option>)}
            </select>
          </label>
          <div className="space-y-1">
            <p className="text-xs font-black text-slate-500">월</p>
            <div className="grid grid-cols-6 gap-1 md:grid-cols-12">
              {MONTHS.map((month) => (
                <button key={month} onClick={() => moveToMonth(currentYear, month)} className={cn("h-8 rounded border text-sm font-black", currentMonth === month ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600")}>
                  {month}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-black text-slate-500">경쟁사</p>
            <div className="grid grid-cols-2 gap-1">
              {(["all", ...COMPETITORS.map((competitor) => competitor.id)] as const).map((id) => {
                const label = id === "all" ? "전체" : COMPETITORS.find((competitor) => competitor.id === id)?.displayName;
                return <button key={id} onClick={() => setCompetitorFilter(id)} className={cn("h-8 rounded border px-2 text-xs font-black", competitorFilter === id ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600")}>{label}</button>;
              })}
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <TablePaintToolbar
                selected={paintSelection}
                inputActive={!isCancellationPaint && lostSelection === null}
                onSelect={(selection) => {
                  setPaintSelection(selection);
                  setIsCancellationPaint(false);
                  setCancellationRangeStart(null);
                  setLostSelection(null);
                }}
                clearTitle="자동 기록이 있는 칸은 삭제하며, 저장 전에는 되돌릴 수 있습니다."
              />
              <div className="flex items-center rounded-xl border border-slate-200 bg-white px-2 py-1.5">
                <button
                  type="button"
                  data-paint-color={MANUAL_CANCELLATION_COLOR}
                  aria-label="취소 회색 색상"
                  title="취소"
                  onClick={() => {
                    setPaintSelection(null);
                    setIsCancellationPaint(true);
                    setCancellationRangeStart(null);
                    setLostSelection(null);
                  }}
                  className={cn(
                    "h-7 w-7 rounded-md border border-slate-400 bg-[#BFBFBF] transition active:scale-95",
                    isCancellationPaint && "ring-2 ring-slate-900 ring-offset-2",
                  )}
                />
              </div>
            </div>
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
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-black text-slate-600">경쟁사 놓침 표시</span>
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
                  setIsCancellationPaint(false);
                  setCancellationRangeStart(null);
                }}
                className={cn(
                  "h-7 rounded border px-2.5 text-[11px] font-black transition active:scale-95",
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
          {editMessage && <p className="mt-1 text-xs font-bold text-slate-500">{editMessage}</p>}
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
            <section key={competitor.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className={cn("rounded-t-2xl border-b border-slate-300 px-4 py-2 text-center text-sm font-black", headerClass(competitor.id))}>{competitor.displayName}</div>
              <div className="overflow-x-auto xl:overflow-visible">
                <table className={MONTHLY_GRID_TABLE_CLASS}>
                  <MonthlyGridColGroup hours={HOURS} />
                  <thead><tr className={MONTHLY_GRID_HEADER_ROW_CLASS}>
                    <th className="sticky left-0 top-auto z-30 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle xl:top-[var(--competitor-header-top)]">날짜</th>
                    <th className={cn("sticky top-auto z-30 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle xl:top-[var(--competitor-header-top)]", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>시간 합계</th>
                    {HOURS.map((hour) => <th key={hour} className="border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle xl:sticky xl:top-[var(--competitor-header-top)] xl:z-20">{hour}</th>)}
                    <th className={cn("sticky right-0 top-auto z-30 border border-slate-300 bg-emerald-50 px-1 py-0.5 text-center align-middle xl:top-[var(--competitor-header-top)]", MONTHLY_GRID_END_DIVIDER_CLASS)}>확인·변경</th>
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
                      ].filter(Boolean);
                      return (
                        <tr key={`${competitor.id}-${dateKey}`} className={MONTHLY_GRID_BODY_ROW_CLASS}>
                          <td className={cn("sticky left-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-semibold group-hover:bg-slate-50", isWeekend && "text-red-500")}>{format(day, "MM월 dd일")}</td>
                          <td className={cn("sticky z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle font-bold text-slate-700 group-hover:bg-slate-50", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>{metrics.billableHours || "-"}</td>
                          {HOURS.map((hour) => {
                            const slot = snapshot?.slots[String(hour)];
                            const cancellation = cancellationAtHour(cancellations, hour);
                            const editableKey = `hour-${hour}`;
                            const key = manualCellKey(competitor.id, day, editableKey);
                            const manualCell = manualCells[key] || emptyCompetitorManualCell();
                            const isManualCancellation = manualCell.color === MANUAL_CANCELLATION_COLOR;
                            const manualClass = isManualCancellation
                              ? "bg-[#BFBFBF] text-slate-950"
                              : manualColorClass(manualCell.color);
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
                            const opportunity = isManualCancellation
                              ? null
                              : lostLabel(manualLost.length > 0 ? manualLost : visibleSlot?.opportunityLostRooms || []);
                            const hasBooking = Boolean((manualClass && !isManualCancellation) || visibleSlot?.state === "closed");
                            const isLostEditing = lostSelection !== null;
                            const isCancellationRangeStart = cancellationRangeStart?.competitorId === competitor.id
                              && cancellationRangeStart.dateKey === dateKey
                              && cancellationRangeStart.hour === hour;
                            const cancellationLabel = showCancellation && visibleCancellation
                              ? cancellationCellLabel(visibleCancellation, hour)
                              : "";
                            const firstDetectedLabel = metrics.firstDetectedLabels[hour] || "";
                            const showFirstDetectedMemo = Boolean(
                              firstDetectedLabel && (cancellationLabel || metrics.labels[hour]),
                            );
                            const unreadEvent = unreadEvents.find((event) => (
                              event.competitorId === competitor.id
                              && event.dateKey === dateKey
                              && event.startHour + Math.floor((event.endHour - event.startHour) / 2) === hour
                            ));
                            return (
                              <td
                                key={`${dateKey}-${hour}`}
                                data-manual-cell-key={key}
                                data-manual-color={manualCell.color || ""}
                                title={showCancellation && visibleCancellation
                                  ? `취소 ${visibleCancellation.startHour}~${visibleCancellation.endHour}시 · ${cancellationDetectedDateLabel(visibleCancellation.occurredAt)} 발견 · 수수료 ${visibleCancellation.feeRate ?? 0}%`
                                  : undefined}
                                onMouseDown={(event) => {
                                  if (paintSelection !== null || isCancellationPaint) {
                                    event.preventDefault();
                                    if (isCancellationPaint) {
                                      applyCancellationRange(competitor.id, day, hour);
                                    } else {
                                      applyPaintToCell(competitor.id, day, editableKey, hasAutoRecord);
                                    }
                                  }
                                }}
                                className={cn(
                                  "relative h-6 border border-slate-300 p-0 text-center align-middle font-semibold",
                                  manualClass || (showCancellation ? "bg-[#BFBFBF] text-slate-950" : slotClass(visibleSlot, isWeekend)),
                                  visibleSlot?.bookingNumber && "border-l-2 border-l-slate-700",
                                  (paintSelection !== null || isCancellationPaint || isLostEditing) && "cursor-crosshair",
                                  isCancellationRangeStart && "z-10 ring-2 ring-inset ring-slate-700",
                                )}
                              >
                                {isLostEditing && (
                                  <button
                                    type="button"
                                    aria-label={`${competitor.displayName} ${format(day, "MM월 dd일")} ${hour}시 놓침 표시 적용`}
                                    title="선택한 놓침 표시 적용"
                                    onClick={() => applyLostToCell(competitor.id, day, hour, hasBooking)}
                                    className="absolute inset-0 z-20 cursor-crosshair bg-transparent"
                                  />
                                )}
                                <EditableTableCellInput
                                  ariaLabel={`${competitor.displayName} ${format(day, "MM월 dd일")} ${hour}시 수동 입력`}
                                  value={manualCell.value}
                                  placeholder={isManualCancellation
                                    ? ""
                                    : cancellationLabel || metrics.labels[hour] || firstDetectedLabel || slotStatusLabel(visibleSlot)}
                                  disabled={paintSelection !== null || isCancellationPaint || isLostEditing}
                                  onChange={(value) => updateManualCell(competitor.id, day, editableKey, { value })}
                                  onCommit={(value) => updateManualCell(competitor.id, day, editableKey, { value })}
                                  className={cn(
                                    "text-center",
                                    showFirstDetectedMemo && "pl-5",
                                    opportunity && "pr-5",
                                    unreadEvent && "text-transparent placeholder:text-transparent",
                                    (paintSelection !== null || isCancellationPaint || isLostEditing) && "pointer-events-none",
                                  )}
                                />
                                {unreadEvent && (
                                  <button
                                    type="button"
                                    title={`${unreadEvent.eventType === "BOOKED" ? "신규 예약" : "신규 취소"} · 눌러서 확인`}
                                    aria-label={`${competitor.displayName} ${format(day, "MM월 dd일")} 신규 ${unreadEvent.eventType === "BOOKED" ? "예약" : "취소"} 확인`}
                                    disabled={isAcknowledging}
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void acknowledgeEvents(unreadEvent.eventIds);
                                    }}
                                    className={cn(
                                      "absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[9px] font-black leading-none text-white shadow-sm disabled:opacity-60",
                                      unreadEvent.eventType === "BOOKED" ? "bg-emerald-600" : "bg-rose-600",
                                    )}
                                  >
                                    신규
                                  </button>
                                )}
                                {showFirstDetectedMemo && (
                                  <span
                                    title={`최초 확인 ${firstDetectedLabel}`}
                                    aria-label={`최초 확인 ${firstDetectedLabel}`}
                                    className="absolute left-0.5 top-0.5 z-10 flex h-4 w-4 items-center justify-center rounded border border-amber-700 bg-white text-amber-800 shadow-sm"
                                  >
                                    <CalendarClock aria-hidden="true" className="h-2.5 w-2.5" />
                                  </span>
                                )}
                                {opportunity && <span title={`${opportunity.full}${manualLost.length > 0 ? " (수동)" : ""}`} aria-label={`${opportunity.full}${manualLost.length > 0 ? " 수동 표시" : ""}`} className="absolute right-0.5 top-0.5 z-10 rounded-sm bg-red-600 px-1 text-[9px] font-black leading-4 text-white">{opportunity.short}✓</span>}
                              </td>
                            );
                          })}
                          <td
                            className={cn("sticky right-0 z-10 border border-slate-300 bg-white px-1 py-0.5 text-center align-middle text-[10px] font-semibold text-slate-600 group-hover:bg-slate-50", MONTHLY_GRID_END_DIVIDER_CLASS, pendingCount > 0 && "text-amber-700")}
                            title={noteParts.join(" / ") || "-"}
                          >
                            <div className="truncate">{noteParts.join(" / ") || "-"}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr className="h-6 bg-slate-100 font-black text-slate-900">
                    <td className="sticky left-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">월 총합</td>
                    <td className={cn("sticky z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_TOTAL_LEFT_CLASS)}>{monthMetrics.billableHours}</td>
                    <td colSpan={2} className="border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle tabular-nums">{isTriground ? `${monthMetrics.revenue.toLocaleString()}원` : ""}</td>
                    <td colSpan={HOURS.length - 2} className="border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle">{isTriground ? "유료 예약 시간 합계" : "예약 확인 시간 합계"}</td>
                    <td className={cn("sticky right-0 z-20 border border-slate-400 bg-slate-100 px-1 py-0.5 text-center align-middle", MONTHLY_GRID_END_DIVIDER_CLASS)}>자동 기록</td>
                  </tr></tfoot>
                </table>
              </div>
            </section>
          );
        })}
      </div>

      {selectedEvidence && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`${competitorDisplayName(selectedEvidence.competitorId)} 판단 확인 화면`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedEvidence(null);
          }}
        >
          <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-black text-slate-950">{competitorDisplayName(selectedEvidence.competitorId)}</h2>
                  <span className="text-xs font-bold text-slate-500">
                    {selectedEvidence.dateKey || "날짜 확인 필요"} · {evidenceTimeLabel(selectedEvidence)}
                  </span>
                </div>
                <p className="mt-1 text-xs font-semibold text-slate-700">{selectedEvidence.reason}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEvidence(null)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-slate-100"
                aria-label="확인 화면 닫기"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-2 sm:p-4">
              <Image
                src={selectedEvidence.imageUrl}
                alt={`${competitorDisplayName(selectedEvidence.competitorId)} 판단 확인용 전체 화면`}
                width={1920}
                height={1080}
                unoptimized
                className="mx-auto h-auto w-full object-contain"
              />
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-2">
              <p className="text-[10px] font-semibold text-slate-500">
                {format(new Date(selectedEvidence.capturedAt), "yyyy.MM.dd HH:mm:ss")} 저장
              </p>
              <button
                type="button"
                onClick={() => void dismissEvidence(selectedEvidence.id)}
                disabled={dismissingEvidenceId === selectedEvidence.id}
                className="h-8 rounded border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 disabled:opacity-40"
              >
                확인 후 목록에서 지우기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
