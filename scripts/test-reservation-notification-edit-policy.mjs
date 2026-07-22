import assert from "node:assert/strict";
import { reservationNotificationEditPolicy } from "../src/lib/reservation-notification-edit-policy.ts";

const now = new Date("2026-07-22T00:00:00.000Z");
const base = {
  phone: "010-1234-5678",
  startTime: new Date("2026-07-23T04:00:00.000Z"),
  endTime: new Date("2026-07-23T07:00:00.000Z"),
  roomName: "머무룸1",
  status: "CONFIRMED",
  notified: true,
  notificationStatus: "DELIVERED",
};

const unchanged = reservationNotificationEditPolicy({
  existing: base,
  next: { ...base, phone: "01012345678" },
  now,
});
assert.deepEqual(unchanged.changedFields, []);
assert.equal(unchanged.requiresConfirmation, false);

const deliveredRoomChange = reservationNotificationEditPolicy({
  existing: base,
  next: { ...base, roomName: "머무룸2" },
  now,
});
assert.deepEqual(deliveredRoomChange.changedFields, ["roomName"]);
assert.equal(deliveredRoomChange.requiresConfirmation, true);
assert.equal(deliveredRoomChange.shouldResetAutomatically, false);

const pendingTimeChange = reservationNotificationEditPolicy({
  existing: { ...base, notified: false, notificationStatus: "PENDING" },
  next: { ...base, notified: false, notificationStatus: "PENDING", endTime: new Date("2026-07-23T08:00:00.000Z") },
  now,
});
assert.deepEqual(pendingTimeChange.changedFields, ["endTime"]);
assert.equal(pendingTimeChange.requiresConfirmation, false);
assert.equal(pendingTimeChange.shouldResetAutomatically, true);

const failedPhoneCorrection = reservationNotificationEditPolicy({
  existing: { ...base, notificationStatus: "FAILED" },
  next: { ...base, notificationStatus: "FAILED", phone: "010-9999-8888" },
  now,
});
assert.equal(failedPhoneCorrection.requiresConfirmation, false);
assert.equal(failedPhoneCorrection.shouldResetAutomatically, true);

const pastReservation = reservationNotificationEditPolicy({
  existing: { ...base, startTime: new Date("2026-07-21T04:00:00.000Z"), endTime: new Date("2026-07-21T07:00:00.000Z") },
  next: { ...base, startTime: new Date("2026-07-21T05:00:00.000Z"), endTime: new Date("2026-07-21T08:00:00.000Z") },
  now,
});
assert.equal(pastReservation.requiresConfirmation, false);
assert.equal(pastReservation.shouldResetAutomatically, false);

console.log("Reservation notification edit-policy tests passed.");
