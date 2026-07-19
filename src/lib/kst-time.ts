const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type KstDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

export function getKstDateParts(value: Date = new Date()): KstDateParts {
  const shifted = new Date(value.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

export function getKstDateKey(value: Date = new Date()) {
  const parts = getKstDateParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function getKstDayOfWeek(value: Date = new Date()) {
  const parts = getKstDateParts(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function isKstWeekend(value: Date = new Date()) {
  const day = getKstDayOfWeek(value);
  return day === 0 || day === 6;
}

export function createKstDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - KST_OFFSET_MS);
}

export function getKstDayRange(value: Date = new Date()) {
  const parts = getKstDateParts(value);
  const start = createKstDate(parts.year, parts.month, parts.day);
  return {
    key: getKstDateKey(value),
    parts,
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1),
  };
}

export function startOfKstMonth(value: Date = new Date()) {
  const parts = getKstDateParts(value);
  return createKstDate(parts.year, parts.month, 1);
}

export function addKstMonths(value: Date, amount: number) {
  const parts = getKstDateParts(value);
  const monthIndex = parts.year * 12 + (parts.month - 1) + amount;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return createKstDate(year, month, 1);
}
