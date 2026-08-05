export const MANUAL_CELL_COLORS = [
  {
    key: "naver-weekday",
    label: "네이버 평일",
    swatchClass: "bg-[#DDEBF7]",
    cellClass: "bg-[#DDEBF7] text-slate-950",
  },
  {
    key: "naver-weekend",
    label: "네이버 주말",
    swatchClass: "bg-[#FCE4D6]",
    cellClass: "bg-[#FCE4D6] text-slate-950",
  },
  {
    key: "spacecloud-weekday",
    label: "스클 평일",
    swatchClass: "bg-[#2F75B5]",
    cellClass: "bg-[#2F75B5] text-slate-950",
  },
  {
    key: "spacecloud-weekend",
    label: "스클 주말",
    swatchClass: "bg-[#C65911]",
    cellClass: "bg-[#C65911] text-slate-950",
  },
  {
    key: "manual-cancelled",
    label: "취소 · 노쇼",
    swatchClass: "bg-[#BFBFBF]",
    cellClass: "bg-[#BFBFBF] text-slate-950",
    monthlyOnly: true,
  },
  {
    key: "provisional-block",
    label: "가예약 · 임시차단",
    swatchClass: "bg-[#E2E8F0]",
    cellClass: "bg-[#E2E8F0] text-slate-950",
    monthlyOnly: true,
  },
  {
    key: "fake-block",
    label: "뻥카",
    swatchClass: "bg-[#E9D5FF]",
    cellClass: "bg-[#E9D5FF] text-slate-950",
    monthlyOnly: true,
  },
] as const;

export type ManualCellColor = (typeof MANUAL_CELL_COLORS)[number]["key"];
export type PaintSelection = ManualCellColor | "clear" | null;

export interface ManualCellData {
  value: string;
  color: ManualCellColor | null;
}

export function emptyManualCell(): ManualCellData {
  return { value: "", color: null };
}

export function manualCellDataEquals(
  left: { value: string; color: string | null },
  right: { value: string; color: string | null },
) {
  return left.value === right.value && left.color === right.color;
}

export function reconcileDirtyKey(previous: Set<string>, key: string, isDirty: boolean) {
  if (previous.has(key) === isDirty) return previous;
  const next = new Set(previous);
  if (isDirty) next.add(key);
  else next.delete(key);
  return next;
}

export function manualColorClass(color?: string | null) {
  return MANUAL_CELL_COLORS.find((item) => item.key === color)?.cellClass || null;
}
