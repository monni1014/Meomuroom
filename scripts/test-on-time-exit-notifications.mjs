import assert from "node:assert/strict";
import { resolveOnTimeExitTargetsWithGroupKey } from "../src/lib/on-time-exit-core.ts";

const time = (clock) => new Date(`2026-07-28T${clock}:00+09:00`);
const reservation = (id, phone, start, end, roomName = "머무룸1") => ({
  id,
  roomName,
  phone,
  startTime: time(start),
  endTime: time(end),
});
const groupKey = (item) => `${item.startTime.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })}|${item.roomName}|${item.phone.replace(/\D/g, "")}`;
const resolveOnTimeExitTargets = (items) => resolveOnTimeExitTargetsWithGroupKey(items, groupKey);

const direct = resolveOnTimeExitTargets([
  reservation("a", "010-1111-1111", "10:00", "12:00"),
  reservation("b", "010-2222-2222", "12:00", "14:00"),
]);
assert.equal(direct.length, 1);
assert.equal(direct[0].leader.id, "a");
assert.equal(direct[0].nextReservation.id, "b");

const sameCustomerSplit = resolveOnTimeExitTargets([
  reservation("a1", "010-1111-1111", "10:00", "12:00"),
  reservation("a2", "010-1111-1111", "12:00", "14:00"),
  reservation("b", "010-2222-2222", "14:00", "16:00"),
]);
assert.equal(sameCustomerSplit.length, 1);
assert.equal(sameCustomerSplit[0].leader.id, "a1");
assert.equal(sameCustomerSplit[0].members.length, 2);
assert.equal(sameCustomerSplit[0].exitTime.toISOString(), time("14:00").toISOString());

assert.equal(resolveOnTimeExitTargets([
  reservation("a", "010-1111-1111", "10:00", "12:00"),
  reservation("b", "010-2222-2222", "13:00", "15:00"),
]).length, 0, "A gap between reservations must not trigger the message");

assert.equal(resolveOnTimeExitTargets([
  reservation("a", "010-1111-1111", "10:00", "12:00"),
  reservation("b", "010-1111-1111", "12:00", "14:00"),
]).length, 0, "The same customer must not receive an exit message between split reservations");

assert.equal(resolveOnTimeExitTargets([
  reservation("a", "010-1111-1111", "10:00", "12:00", "머무룸1"),
  reservation("b", "010-2222-2222", "12:00", "14:00", "머무룸2"),
]).length, 0, "A reservation in another room must not trigger the message");

console.log("On-time exit notification tests passed.");
