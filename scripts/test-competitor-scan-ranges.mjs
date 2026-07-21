import assert from "node:assert/strict";
import { resolveCompetitorScanRange } from "../src/lib/competitor-scan-range.ts";

const today = "2026-07-21";

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "today-plus-seven" }, today),
  { startKey: "2026-07-21", endKey: "2026-07-28" },
  "The noon/evening scan must include today and the following seven days.",
);

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
