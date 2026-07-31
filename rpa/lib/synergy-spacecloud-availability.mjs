const KST_TIME_ZONE = "Asia/Seoul";
const FIRST_TRACKED_HOUR = 8;
const LAST_TRACKED_HOUR = 23;

export function kstClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
  };
}

function apiDateKey(day) {
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

export function parseSynergySpacecloudAvailability(payload, {
  startKey,
  endKey,
  checkedAt = new Date(),
} = {}) {
  if (!startKey || !endKey) throw new Error("startKey and endKey are required");
  const now = kstClockParts(checkedAt);
  const days = new Map(
    (Array.isArray(payload?.days) ? payload.days : [])
      .map((day) => [apiDateKey(day), day]),
  );
  const observations = [];

  for (let cursor = startKey; cursor <= endKey;) {
    const day = days.get(cursor);
    const times = new Map(
      (Array.isArray(day?.times) ? day.times : [])
        .filter((time) => Number.isInteger(Number(time.hour)))
        .map((time) => [Number(time.hour), time]),
    );

    for (let hour = FIRST_TRACKED_HOUR; hour <= LAST_TRACKED_HOUR; hour += 1) {
      let observedState = "UNKNOWN";
      let reason = "SPACECLOUD_SLOT_MISSING";
      if (cursor < now.dateKey || (cursor === now.dateKey && hour <= now.hour)) {
        observedState = "POLICY_CLOSED";
        reason = "PAST_OR_CURRENT_HOUR_NOT_USED_FOR_BOOKING_INFERENCE";
      } else if (times.has(hour)) {
        observedState = times.get(hour)?.available === true ? "AVAILABLE" : "BOOKED";
        reason = observedState === "AVAILABLE"
          ? "SPACECLOUD_PUBLIC_SLOT_AVAILABLE"
          : "SPACECLOUD_PUBLIC_SLOT_CLOSED";
      }
      observations.push({
        competitorId: "synergy-spacecloud",
        dateKey: cursor,
        hour,
        observedState,
        reason,
        checkedAt: checkedAt.toISOString(),
      });
    }

    const next = new Date(`${cursor}T00:00:00+09:00`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toLocaleDateString("en-CA", { timeZone: KST_TIME_ZONE });
  }

  return observations;
}

export function monthsInRange(startKey, endKey) {
  const [startYear, startMonth] = startKey.split("-").map(Number);
  const [endYear, endMonth] = endKey.split("-").map(Number);
  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return months;
}
