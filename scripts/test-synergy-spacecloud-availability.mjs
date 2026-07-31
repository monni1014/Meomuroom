import assert from "node:assert/strict";
import {
  monthsInRange,
  parseSynergySpacecloudAvailability,
} from "../rpa/lib/synergy-spacecloud-availability.mjs";
import {
  crossCheckSynergySpacecloudWithNaver,
  SPACECLOUD_AND_NAVER_CLOSED_REASON,
  SPACECLOUD_ONLY_CLOSED_REASON,
} from "../src/lib/synergy-spacecloud-cross-check.ts";

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

const sameDayCutoff = parseSynergySpacecloudAvailability({
  days: [{
    year: "2026",
    month: "7",
    day: "31",
    times: [
      { hour: 17, available: false },
      { hour: 18, available: false },
    ],
  }],
}, {
  startKey: "2026-07-31",
  endKey: "2026-07-31",
  checkedAt: new Date("2026-07-31T05:30:00.000Z"), // 14:30 KST
});
assert.equal(sameDayCutoff.find((item) => item.hour === 17)?.observedState, "POLICY_CLOSED");
assert.equal(
  sameDayCutoff.find((item) => item.hour === 17)?.reason,
  "SAME_DAY_THREE_HOUR_BOOKING_CUTOFF",
);
assert.equal(sameDayCutoff.find((item) => item.hour === 18)?.observedState, "BOOKED");

const crossChecked = crossCheckSynergySpacecloudWithNaver([
  {
    competitorId: "synergy-spacecloud",
    dateKey: "2026-08-01",
    hour: 9,
    observedState: "BOOKED",
    reason: "SPACECLOUD_PUBLIC_SLOT_CLOSED",
  },
  {
    competitorId: "synergy-spacecloud",
    dateKey: "2026-08-01",
    hour: 10,
    observedState: "BOOKED",
    reason: "SPACECLOUD_PUBLIC_SLOT_CLOSED",
  },
], [
  { dateKey: "2026-08-01", hour: 9, state: "BOOKED" },
  { dateKey: "2026-08-01", hour: 10, state: "AVAILABLE" },
]);
assert.equal(crossChecked[0].observedState, "BOOKED");
assert.equal(crossChecked[0].reason, SPACECLOUD_AND_NAVER_CLOSED_REASON);
assert.equal(crossChecked[1].observedState, "POLICY_CLOSED");
assert.equal(crossChecked[1].reason, SPACECLOUD_ONLY_CLOSED_REASON);
assert.deepEqual(monthsInRange("2026-07-31", "2026-09-01"), [
  { year: 2026, month: 7 },
  { year: 2026, month: 8 },
  { year: 2026, month: 9 },
]);

console.log("Synergy SpaceCloud availability tests passed.");
