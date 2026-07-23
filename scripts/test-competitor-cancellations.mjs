import assert from "node:assert/strict";
import {
  cancellationDetectedDateLabel,
  cancellationEquivalentHours,
  competitorCancellationFeeRate,
  shouldDisplayZeroFeeCancellationAsNew,
  trigroundBookingRevenue,
  trigroundCancellationRevenue,
} from "../src/lib/competitor-cancellation.ts";

const dayBefore = new Date("2026-07-21T09:00:00.000Z"); // 2026-07-21 18:00 KST

assert.equal(
  competitorCancellationFeeRate("triground-b", "2026-07-22", dayBefore, 1),
  0,
  "A one-hour Triground booking is free and must never create a cancellation fee.",
);
assert.equal(
  competitorCancellationFeeRate("triground-b", "2026-07-22", dayBefore, 2),
  50,
  "A two-hour Triground booking keeps the normal day-before cancellation policy.",
);
assert.equal(
  competitorCancellationFeeRate("synergy", "2026-07-22", dayBefore, 2),
  100,
  "Synergy keeps its own cancellation policy.",
);
assert.equal(cancellationEquivalentHours(2, 50), 1);
assert.equal(cancellationEquivalentHours(3, 30), 0.9);
assert.equal(cancellationEquivalentHours(1, 0), 0);
assert.equal(trigroundBookingRevenue(1), 0);
assert.equal(trigroundBookingRevenue(2), 24_000);
assert.equal(trigroundBookingRevenue(3), 24_000);
assert.equal(trigroundCancellationRevenue(1, 100), 0);
assert.equal(trigroundCancellationRevenue(2, 100), 24_000);
assert.equal(trigroundCancellationRevenue(3, 100), 24_000);
assert.equal(trigroundCancellationRevenue(3, 50), 12_000);
assert.equal(trigroundCancellationRevenue(3, 0), 0);
assert.equal(
  cancellationDetectedDateLabel("2026-07-22T15:30:00.000Z"),
  "7/23",
  "Cancellation discovery dates must be shown in Korea time even across a UTC date boundary.",
);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("triground-a", 1, 0), true);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("triground-b", 1, 0), true);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("triground-b", 2, 0), true);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("triground-a", 3, 0), true);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("synergy", 1, 0), true);
assert.equal(shouldDisplayZeroFeeCancellationAsNew("triground-b", 1, 50), false);

console.log("Competitor cancellation tests passed.");
