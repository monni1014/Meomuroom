import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildReservationEndReminderContent,
  isReservationEndReminderDue,
  resolveReservationEndReminderGroup,
  resolveReservationEndReminderHeadCount,
  splitReservationEndReminderGroups,
} from "../src/lib/reservation-end-reminder-policy.ts";

const now = new Date("2026-07-24T05:00:00.000Z");
const content = buildReservationEndReminderContent({
  roomName: "머무룸1",
  customerName: "김영광",
  headCount: 4,
});
assert.equal(content.title, "예약 종료 알림");
assert.equal(content.body, "머무룸1\n김영광\n4명\n종료 10분 전");
const unpaidExtraContent = buildReservationEndReminderContent({
  roomName: "머무룸2",
  customerName: "추가금 고객",
  headCount: 18,
  additionalPeople: 1,
  unpaidExtraAmount: 12_000,
});
assert.equal(
  unpaidExtraContent.body,
  "머무룸2\n추가금 고객\n18명\n종료 10분 전\n추가금 결제 필요 · 추가 인원 1명 · 12,000원",
);
const missingExtraAmountContent = buildReservationEndReminderContent({
  roomName: "머무룸3",
  customerName: "금액 미입력 고객",
  headCount: 6,
  additionalPeople: 2,
});
assert.match(missingExtraAmountContent.body, /추가금 확인 필요 · 추가 인원 2명/);
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 9, reservedHeadCount: 8 }), 9);
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 0, reservedHeadCount: 8 }), 8);
assert.equal(resolveReservationEndReminderHeadCount({ headCount: 0, reservedHeadCount: 0 }), 0);
const splitPaymentGroup = resolveReservationEndReminderGroup([
  { id: "first", endTime: new Date("2026-07-25T06:00:00.000Z") },
  { id: "last", endTime: new Date("2026-07-25T11:00:00.000Z") },
]);
assert.equal(splitPaymentGroup.reminder?.id, "last");
assert.equal(splitPaymentGroup.members.length, 2);
const separatedGroups = splitReservationEndReminderGroups([
  {
    id: "morning",
    startTime: new Date("2026-07-29T01:00:00.000Z"),
    endTime: new Date("2026-07-29T03:00:00.000Z"),
  },
  {
    id: "afternoon",
    startTime: new Date("2026-07-29T05:00:00.000Z"),
    endTime: new Date("2026-07-29T07:00:00.000Z"),
  },
]);
assert.deepEqual(separatedGroups.map((group) => group.map((member) => member.id)), [
  ["morning"],
  ["afternoon"],
]);
const continuousGroups = splitReservationEndReminderGroups([
  {
    id: "first",
    startTime: new Date("2026-07-29T01:00:00.000Z"),
    endTime: new Date("2026-07-29T03:00:00.000Z"),
  },
  {
    id: "second",
    startTime: new Date("2026-07-29T03:00:00.000Z"),
    endTime: new Date("2026-07-29T05:00:00.000Z"),
  },
]);
assert.deepEqual(continuousGroups.map((group) => group.map((member) => member.id)), [
  ["first", "second"],
]);
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
assert.match(reminderSource, /splitReservationEndReminderGroups\(sameDayGroup\)/);
assert.match(reminderSource, /reservationNotificationGroupKey\(reservation\)/);
assert.match(reminderSource, /resolvedGroup\.reminder\?\.id !== reservation\.id/);
assert.match(reminderSource, /groupAlreadySent\(group\.map\(\(member\) => member\.id\)\)/);
assert.match(reminderSource, /item\.usageLog\.isExtraPaid/);
assert.match(reminderSource, /unpaidExtraMembers/);

console.log("Reservation end reminder tests passed.");
