import assert from "node:assert/strict";
import { resolveCompetitorScanRange } from "../src/lib/competitor-scan-range.ts";

const today = "2026-07-21";

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "today-plus-seven" }, today),
  { startKey: "2026-07-21", endKey: "2026-07-28" },
  "The noon/evening scan must include today and the following seven days.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "next-week" }, today),
  { startKey: "2026-07-22", endKey: "2026-07-28" },
  "The 23:00 scan must skip the nearly finished current day.",
);

assert.deepEqual(
  resolveCompetitorScanRange({ mode: "today-next" }, today),
  { startKey: "2026-07-21", endKey: "2026-07-22" },
);

console.log("Competitor scan range tests passed.");
