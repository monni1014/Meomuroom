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

export function manualColorClass(color?: string | null) {
  return MANUAL_CELL_COLORS.find((item) => item.key === color)?.cellClass || null;
}
