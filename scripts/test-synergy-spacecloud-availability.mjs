import assert from "node:assert/strict";
import {
  monthsInRange,
  parseSynergySpacecloudAvailability,
} from "../rpa/lib/synergy-spacecloud-availability.mjs";

const payload = {
  days: [{
    year: "2026",
    month: "8",
    day: "01",
    times: [
      { hour: 8, available: true },
      { hour: 9, available: false },
    ],
  }],
};
const observations = parseSynergySpacecloudAvailability(payload, {
  startKey: "2026-08-01",
  endKey: "2026-08-01",
  checkedAt: new Date("2026-07-31T10:00:00.000Z"),
});
assert.equal(observations.find((item) => item.hour === 8)?.observedState, "AVAILABLE");
assert.equal(observations.find((item) => item.hour === 9)?.observedState, "BOOKED");
assert.equal(observations.find((item) => item.hour === 10)?.observedState, "UNKNOWN");

const today = parseSynergySpacecloudAvailability({
  days: [{ year: "2026", month: "7", day: "31", times: [{ hour: 17, available: false }] }],
}, {
  startKey: "2026-07-31",
  endKey: "2026-07-31",
  checkedAt: new Date("2026-07-31T08:30:00.000Z"), // 17:30 KST
});
assert.equal(today.find((item) => item.hour === 17)?.observedState, "POLICY_CLOSED");
assert.deepEqual(monthsInRange("2026-07-31", "2026-09-01"), [
  { year: 2026, month: 7 },
  { year: 2026, month: 8 },
  { year: 2026, month: 9 },
]);

console.log("Synergy SpaceCloud availability tests passed.");
