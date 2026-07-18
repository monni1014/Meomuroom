// MonthlyTable and CompetitorsView must share this layout so their columns never drift apart.
export const MONTHLY_GRID_TABLE_CLASS =
  "w-full min-w-[1330px] table-fixed border-collapse text-[11px] xl:min-w-0";

export const MONTHLY_GRID_HEADER_ROW_CLASS = "h-6 bg-emerald-50 text-slate-900";
export const MONTHLY_GRID_BODY_ROW_CLASS = "group h-6 hover:bg-slate-50";
export const MONTHLY_GRID_TOTAL_LEFT_CLASS = "left-[5.5%]";
export const MONTHLY_GRID_END_DIVIDER_CLASS =
  "border-l-2 border-l-slate-400 shadow-[inset_2px_0_0_#94a3b8]";

const DATE_WIDTH_PERCENT = 5.5;
const TOTAL_WIDTH_PERCENT = 4.5;
const END_WIDTH_PERCENT = 7;

export function MonthlyGridColGroup({ hours }: { hours: readonly number[] }) {
  const hourWidth = `${(
    (100 - DATE_WIDTH_PERCENT - TOTAL_WIDTH_PERCENT - END_WIDTH_PERCENT)
    / Math.max(hours.length, 1)
  ).toFixed(7)}%`;

  return (
    <colgroup>
      <col style={{ width: `${DATE_WIDTH_PERCENT}%` }} />
      <col style={{ width: `${TOTAL_WIDTH_PERCENT}%` }} />
      {hours.map((hour) => <col key={hour} style={{ width: hourWidth }} />)}
      <col style={{ width: `${END_WIDTH_PERCENT}%` }} />
    </colgroup>
  );
}
