import assert from "node:assert/strict";
import {
  buildMemoroomContactName,
  chooseReservationForContact,
} from "../src/lib/google-people-contact-name.ts";

assert.equal(
  buildMemoroomContactName({
    roomName: "머무룸 3",
    startTime: new Date("2026-07-23T03:00:00.000Z"),
    customerName: "김종성",
  }),
  "머무룸3 7/23 김종성",
);

assert.equal(
  buildMemoroomContactName({
    roomName: "머무룸1",
    startTime: new Date("2026-12-01T01:00:00.000Z"),
    customerName: null,
  }),
  "머무룸1 12/1 이름없음",
);

console.log("Google People contact-name tests passed.");

const now = new Date("2026-07-22T04:00:00.000Z");
const recentPast = {
  label: "recent-past",
  startTime: new Date("2026-07-21T03:00:00.000Z"),
  endTime: new Date("2026-07-21T06:00:00.000Z"),
};
const nearestFuture = {
  label: "nearest-future",
  startTime: new Date("2026-07-23T03:00:00.000Z"),
  endTime: new Date("2026-07-23T05:00:00.000Z"),
};
const laterFuture = {
  label: "later-future",
  startTime: new Date("2026-07-25T03:00:00.000Z"),
  endTime: new Date("2026-07-25T05:00:00.000Z"),
};

assert.equal(
  chooseReservationForContact([recentPast, laterFuture, nearestFuture], now)?.label,
  "nearest-future",
);
assert.equal(
  chooseReservationForContact([recentPast], now)?.label,
  "recent-past",
);

console.log("Google People reservation-selection tests passed.");
