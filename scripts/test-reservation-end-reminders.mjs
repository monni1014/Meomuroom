import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildReservationEndReminderContent,
  isReservationEndReminderDue,
  resolveReservationEndReminderGroup,
  resolveReservationEndReminderHeadCount,
} from "../src/lib/reservation-end-reminder-policy.ts";

const now = new Date("2026-07-24T05:00:00.000Z");
const content = buildReservationEndReminderContent({
  roomName: "머무룸1",
  customerName: "김영광",
  headCount: 4,
});
assert.equal(content.title, "예약 종료 알림");
assert.equal(content.body, "머무룸1\n김영광\n4명\n종료 10분 전");
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 9, reservedHeadCount: 8 }), 9);
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 0, reservedHeadCount: 8 }), 8);
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 0, reservedHeadCount: 0 }), 0);
const splitPaymentGroup = resolveReservationEndReminderGroup([
  { id: "first", endTime: new Date("2026-07-25T06:00:00.000Z") },
  { id: "last", endTime: new Date("2026-07-25T11:00:00.000Z") },
]);
assert.equal(splitPaymentGroup.reminder?.id, "last");
assert.equal(splitPaymentGroup.members.length, 2);
assert.equal(isReservationEndReminderDue({
  startTime: new Date("2026-07-24T04:00:00.000Z"),
  endTime: new Date("2026-07-24T05:10:00.000Z"),
  status: "CONFIRMED",
  isNoShow: false,
}, now), true);
assert.equal(isReservationEndReminderDue({
  startTime: new Date("2026-07-24T04:00:00.000Z"),
  endTime: new Date("2026-07-24T05:10:01.000Z"),
  status: "CONFIRMED",
  isNoShow: false,
}, now), false);
assert.equal(isReservationEndReminderDue({
  startTime: new Date("2026-07-24T04:00:00.000Z"),
  endTime: new Date("2026-07-24T05:09:00.000Z"),
  status: "CANCELLED",
  isNoShow: false,
}, now), false);

const reminderSource = await readFile(
  new URL("../src/lib/reservation-end-reminders.ts", import.meta.url),
  "utf8",
);
assert.match(reminderSource, /buildReservationNotificationGroups\(groupCandidates\)/);
assert.match(reminderSource, /reservationNotificationGroupKey\(reservation\)/);
assert.match(reminderSource, /resolvedGroup\.reminder\?\.id !== reservation\.id/);
assert.match(reminderSource, /groupAlreadySent\(group\.map\(\(member\) => member\.id\)\)/);

console.log("Reservation end reminder tests passed.");
