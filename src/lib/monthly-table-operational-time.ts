const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const OPERATIONAL_DAY_CUTOFF_HOUR = 2;

function getKstParts(value: Date) {
  const shifted = new Date(value.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function getKstDateKey(value: Date) {
  const parts = getKstParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function getMonthlyTableDisplayHour(value: Date) {
  const parts = getKstParts(value);
  const hour = parts.hour + parts.minute / 60;
  return parts.hour < OPERATIONAL_DAY_CUTOFF_HOUR ? hour + 24 : hour;
}

export function getMonthlyTableOperationalDateKey(value: Date) {
  const parts = getKstParts(value);
  const operationalDate = parts.hour < OPERATIONAL_DAY_CUTOFF_HOUR
    ? new Date(value.getTime() - DAY_MS)
    : value;
  return getKstDateKey(operationalDate);
}

export function isMonthlyTableCellWeekend(dateKey: string, hour: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const calendarDayOffset = hour >= 24 ? 1 : 0;
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day + calendarDayOffset)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}
