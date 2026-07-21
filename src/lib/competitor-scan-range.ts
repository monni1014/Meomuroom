export type CompetitorScanMode =
  | "today"
  | "today-next"
  | "today-plus-seven"
  | "next-week"
  | "daily"
  | "weekly"
  | "monthly"
  | "range";

type RangeOptions = {
  mode: CompetitorScanMode;
  startKey?: string;
  endKey?: string;
};

function kstDateKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function addDays(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + amount);
  return kstDateKey(date);
}

function endOfMonthKey(dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
}

function calendarWeekday(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

export function resolveCompetitorScanRange(options: RangeOptions, today = kstDateKey()) {
  if (options.mode === "range") {
    if (!options.startKey || !options.endKey) throw new Error("Range scan requires startKey and endKey");
    return { startKey: options.startKey, endKey: options.endKey };
  }
  if (options.mode === "today") return { startKey: today, endKey: today };
  if (options.mode === "today-next") return { startKey: today, endKey: addDays(today, 1) };
  if (options.mode === "today-plus-seven" || options.mode === "daily") {
    return { startKey: today, endKey: addDays(today, 7) };
  }
  if (options.mode === "next-week") return { startKey: addDays(today, 1), endKey: addDays(today, 7) };
  if (options.mode === "monthly") return { startKey: today, endKey: endOfMonthKey(today) };

  const daysUntilSunday = (7 - calendarWeekday(today)) % 7;
  return { startKey: today, endKey: addDays(today, daysUntilSunday) };
}
