import assert from "node:assert/strict";
import {
  resolveCancellationConfirmationRange,
  resolveCompetitorScanRange,
  resolveCompetitorStartupMode,
} from "../src/lib/competitor-scan-range.ts";

const today = "2026-07-21";

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "today-plus-seven" }, today),
  { startKey: "2026-07-21", endKey: "2026-07-28" },
  "The noon/evening scan must include today and the following seven days.",
);

assert.equal(resolveCompetitorStartupMode(new Date("2026-07-23T14:01:00.000Z")), "night-month-horizon");
assert.equal(resolveCompetitorStartupMode(new Date("2026-07-23T09:01:00.000Z")), "today-plus-seven");
assert.equal(resolveCompetitorStartupMode(new Date("2026-07-22T22:01:00.000Z")), "today-next");
assert.equal(resolveCompetitorStartupMode(new Date("2026-07-31T22:01:00.000Z")), "monthly");

assert.deepEqual(
  resolveCancellationConfirmationRange(["2026-07-26", "2026-07-24", "2026-07-26"]),
  { startKey: "2026-07-24", endKey: "2026-07-26" },
);
assert.equal(resolveCancellationConfirmationRange([]), null);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "night-month-horizon" }, today),
  { startKey: "2026-07-22", endKey: "2026-07-31" },
  "A normal 23:00 scan must cover tomorrow through the end of this month.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "night-month-horizon" }, "2026-07-25"),
  { startKey: "2026-07-26", endKey: "2026-08-15" },
  "During the final seven days, the 23:00 scan must extend through next month day 15.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "night-month-horizon" }, "2026-07-31"),
  { startKey: "2026-08-01", endKey: "2026-08-15" },
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "night-month-horizon" }, "2027-02-22"),
  { startKey: "2027-02-23", endKey: "2027-03-15" },
  "The final-week rule must also work for a 28-day February.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "monthly" }, "2026-08-01"),
  { startKey: "2026-08-01", endKey: "2026-08-31" },
  "The first-day monthly scan must cover the entire current month.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "today-next" }, today),
  { startKey: "2026-07-21", endKey: "2026-07-22" },
);

console.log("Competitor scan range tests passed.");
