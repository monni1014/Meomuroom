import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getKstDateKey } from "../src/lib/kst-time.ts";
import { normalizeKoreanPhone } from "../src/lib/phone-number.ts";

const first = {
  roomName: "머무룸2",
  phone: "010-5643-0936",
  startTime: new Date("2026-07-25T13:00:00+09:00"),
};
const second = {
  roomName: "머무룸2",
  phone: "01056430936",
  startTime: new Date("2026-07-25T15:00:00+09:00"),
};

const crossMidnightPrevious = {
  roomName: "머무룸1",
  phone: "010-5208-5138",
  startTime: new Date("2026-08-02T22:00:00+09:00"),
  endTime: new Date("2026-08-03T00:00:00+09:00"),
};
const crossMidnightExtension = {
  roomName: "머무룸1",
  phone: "01052085138",
  startTime: new Date("2026-08-03T00:00:00+09:00"),
  endTime: new Date("2026-08-03T02:00:00+09:00"),
};

const key = (reservation) => [
  getKstDateKey(reservation.startTime),
  reservation.roomName.trim(),
  normalizeKoreanPhone(reservation.phone),
].join("|");

assert.equal(key(first), "2026-07-25|머무룸2|01056430936");
assert.equal(key(first), key(second));
assert.notEqual(key(crossMidnightPrevious), key(crossMidnightExtension));
assert.equal(crossMidnightPrevious.endTime.getTime(), crossMidnightExtension.startTime.getTime());
assert.equal(
  normalizeKoreanPhone(crossMidnightPrevious.phone),
  normalizeKoreanPhone(crossMidnightExtension.phone),
);

const groupingSource = await readFile(
  new URL("../src/lib/reservation-notification-grouping.ts", import.meta.url),
  "utf8",
);
const notificationSource = await readFile(
  new URL("../src/lib/reservation-notifications.ts", import.meta.url),
  "utf8",
);
const messagesPageSource = await readFile(
  new URL("../src/app/messages/page.tsx", import.meta.url),
  "utf8",
);

assert.match(groupingSource, /getKstDateKey\(reservation\.startTime\)/);
assert.match(groupingSource, /reservation\.roomName\.trim\(\)/);
assert.match(groupingSource, /normalizeKoreanPhone\(reservation\.phone\)/);
assert.match(groupingSource, /isContiguousReservationNotificationExtension/);
assert.match(groupingSource, /previous\.endTime\.getTime\(\) === next\.startTime\.getTime\(\)/);
assert.match(notificationSource, /buildReservationNotificationGroups\(groupCandidates\)/);
assert.match(notificationSource, /GROUPING_LOOKBACK_MS/);
assert.match(notificationSource, /isContiguousReservationNotificationExtension\(candidate, reservation\)/);
assert.match(notificationSource, /resolveGroupLeader\(reservation\)/);
assert.match(notificationSource, /groupMembers\.slice\(1\)/);
assert.match(notificationSource, /await skipGroupedFollowers\(reservation\)/);
assert.match(messagesPageSource, /buildReservationNotificationGroups\(reservations\)/);
assert.match(messagesPageSource, /groupLeaderByFollowerId\.set\(follower\.id, leader\)/);
assert.match(messagesPageSource, /groupLeader[\s\S]*?status = "SKIPPED"/);

console.log("Reservation notification grouping tests passed.");
