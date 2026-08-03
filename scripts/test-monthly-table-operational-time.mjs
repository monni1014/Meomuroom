import assert from "node:assert/strict";
import {
  getMonthlyTableDisplayHour,
  getMonthlyTableOperationalDateKey,
  isMonthlyTableCellWeekend,
} from "../src/lib/monthly-table-operational-time.ts";

const kst = (value) => new Date(`${value}+09:00`);

assert.equal(getMonthlyTableOperationalDateKey(kst("2026-08-03T00:00:00")), "2026-08-02");
assert.equal(getMonthlyTableOperationalDateKey(kst("2026-08-03T01:00:00")), "2026-08-02");
assert.equal(getMonthlyTableDisplayHour(kst("2026-08-03T00:00:00")), 24);
assert.equal(getMonthlyTableDisplayHour(kst("2026-08-03T01:00:00")), 25);

assert.equal(getMonthlyTableOperationalDateKey(kst("2026-08-03T02:00:00")), "2026-08-03");
assert.equal(getMonthlyTableDisplayHour(kst("2026-08-03T02:00:00")), 2);

assert.equal(isMonthlyTableCellWeekend("2026-08-02", 23), true);
assert.equal(isMonthlyTableCellWeekend("2026-08-02", 24), false);
assert.equal(isMonthlyTableCellWeekend("2026-08-02", 25), false);

assert.equal(getMonthlyTableOperationalDateKey(kst("2026-09-01T00:00:00")), "2026-08-31");

console.log("Monthly table operational-time tests passed.");
