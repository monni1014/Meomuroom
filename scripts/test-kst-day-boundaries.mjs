import assert from "node:assert/strict";
import {
  addKstMonths,
  createKstDate,
  getKstDateKey,
  getKstDateParts,
  getKstDayOfWeek,
  getKstDayRange,
  startOfKstMonth,
} from "../src/lib/kst-time.ts";

const beforeMidnight = getKstDayRange(new Date("2026-07-19T14:59:59.999Z"));
assert.equal(beforeMidnight.key, "2026-07-19");
assert.equal(beforeMidnight.start.toISOString(), "2026-07-18T15:00:00.000Z");
assert.equal(beforeMidnight.end.toISOString(), "2026-07-19T14:59:59.999Z");

const afterMidnight = getKstDayRange(new Date("2026-07-19T15:00:00.000Z"));
assert.equal(afterMidnight.key, "2026-07-20");
assert.equal(afterMidnight.start.toISOString(), "2026-07-19T15:00:00.000Z");
assert.equal(afterMidnight.end.toISOString(), "2026-07-20T14:59:59.999Z");
assert.equal(getKstDateKey(new Date("2026-07-19T15:30:00.000Z")), "2026-07-20");
assert.equal(getKstDayOfWeek(new Date("2026-07-19T15:30:00.000Z")), 1);

const newYear = getKstDateParts(new Date("2025-12-31T15:00:00.000Z"));
assert.deepEqual(
  { year: newYear.year, month: newYear.month, day: newYear.day },
  { year: 2026, month: 1, day: 1 },
);

assert.equal(startOfKstMonth(new Date("2026-07-19T15:21:00.000Z")).toISOString(), "2026-06-30T15:00:00.000Z");
assert.equal(addKstMonths(createKstDate(2026, 12, 1), 1).toISOString(), "2026-12-31T15:00:00.000Z");

console.log("KST day-boundary checks passed (5 cases).");
