"use client";

import { Eraser, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MANUAL_CELL_COLORS, PaintSelection } from "@/lib/manual-table-colors";

interface TablePaintToolbarProps {
  selected: PaintSelection;
  onSelect: (selection: PaintSelection) => void;
}

export function TablePaintToolbar({ selected, onSelect }: TablePaintToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-paint-tool="input"
        onClick={() => onSelect(null)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition active:scale-95",
          selected === null
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
        onClick={() => onSelect("clear")}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition active:scale-95",
          selected === "clear"
            ? "border-rose-500 bg-rose-50 text-rose-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        )}
      >
        <Eraser className="h-3.5 w-3.5" />
        색 지우기
      </button>
      <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
        {MANUAL_CELL_COLORS.map((color) => (
          <button
            key={color.key}
            type="button"
            data-paint-color={color.key}
            aria-label={`${color.label} 색상`}
            title={color.label}
            onClick={() => onSelect(color.key)}
            className={cn(
              "h-6 w-6 rounded-lg border border-slate-300 transition active:scale-95",
              color.swatchClass,
              selected === color.key && "ring-2 ring-slate-900 ring-offset-2"
            )}
          />
        ))}
      </div>
    </div>
  );
}
