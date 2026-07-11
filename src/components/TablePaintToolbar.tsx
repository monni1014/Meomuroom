"use client";

import { Eraser, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MANUAL_CELL_COLORS, PaintSelection } from "@/lib/manual-table-colors";

interface TablePaintToolbarProps {
  selected: PaintSelection;
  onSelect: (selection: PaintSelection) => void;
  clearLabel?: string;
  clearTitle?: string;
  showColorLabels?: boolean;
  inputActive?: boolean;
  showMonthlyOnlyColors?: boolean;
}

export function TablePaintToolbar({
  selected,
  onSelect,
  clearLabel = "색 지우기",
  clearTitle,
  showColorLabels = false,
  inputActive = true,
  showMonthlyOnlyColors = false,
}: TablePaintToolbarProps) {
  const standardColors = MANUAL_CELL_COLORS.filter(
    (color) => !("monthlyOnly" in color && color.monthlyOnly),
  );
  const monthlyOnlyColors = showMonthlyOnlyColors
    ? MANUAL_CELL_COLORS.filter((color) => "monthlyOnly" in color && color.monthlyOnly)
    : [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-paint-tool="input"
        onClick={() => onSelect(null)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition active:scale-95",
          selected === null && inputActive
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        )}
      >
        <MousePointer2 className="h-3.5 w-3.5" />
        입력
      </button>
      <button
        type="button"
        data-paint-tool="clear"
        title={clearTitle}
        onClick={() => onSelect("clear")}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition active:scale-95",
          selected === "clear"
            ? "border-rose-500 bg-rose-50 text-rose-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        )}
      >
        <Eraser className="h-3.5 w-3.5" />
        {clearLabel}
      </button>
      <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
        {standardColors.map((color) => (
          <button
            key={color.key}
            type="button"
            data-paint-color={color.key}
            aria-label={`${color.label} 색상`}
            title={color.label}
            onClick={() => onSelect(color.key)}
            className={cn(
              "inline-flex h-7 items-center rounded-md border border-slate-300 transition active:scale-95",
              showColorLabels ? "gap-1.5 px-2 text-[11px] font-bold text-slate-700" : "w-7 justify-center",
              color.swatchClass,
              selected === color.key && "ring-2 ring-slate-900 ring-offset-2"
            )}
          >
            {showColorLabels && color.label}
          </button>
        ))}
      </div>
      {monthlyOnlyColors.map((color) => (
        <div key={color.key} className="flex items-center rounded-xl border border-slate-200 bg-white px-2 py-1.5">
          <button
            type="button"
            data-paint-color={color.key}
            aria-label={`${color.label} 색상`}
            title={color.label}
            onClick={() => onSelect(color.key)}
            className={cn(
              "inline-flex h-7 items-center rounded-md border border-slate-300 transition active:scale-95",
              showColorLabels ? "gap-1.5 px-2 text-[11px] font-bold text-white" : "w-7 justify-center",
              color.swatchClass,
              selected === color.key && "ring-2 ring-slate-900 ring-offset-2",
            )}
          >
            {showColorLabels && color.label}
          </button>
        </div>
      ))}
    </div>
  );
}
