import assert from "node:assert/strict";
import { buildReservationNotificationFailureAlert } from "../src/lib/reservation-notification-failure-alert.ts";

const alert = buildReservationNotificationFailureAlert({
  roomName: "머무룸2",
  customerName: "홍길동",
  startTime: new Date("2026-07-23T05:00:00.000Z"),
  endTime: new Date("2026-07-23T08:00:00.000Z"),
  error: "통신사 수신 거절",
});

assert.equal(alert.title, "문자 수신 실패");
assert.equal(alert.message, "머무룸2\n홍길동 · 7월 23일 14:00~17:00 예약\n사유: 통신사 수신 거절");

const midnightAlert = buildReservationNotificationFailureAlert({
  roomName: "머무룸3",
  customerName: "김머무",
  startTime: new Date("2026-07-23T12:00:00.000Z"),
  endTime: new Date("2026-07-23T15:00:00.000Z"),
});

assert.equal(midnightAlert.message, "머무룸3\n김머무 · 7월 23일 21:00~7월 24일 00:00 예약\n사유: 문자 수신 실패");

console.log("Notification failure alert formatting tests passed.");
