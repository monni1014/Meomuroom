import assert from "node:assert/strict";
import {
  buildReservationDeletionLogData,
  normalizeDeletionSource,
} from "../src/lib/reservation-deletion-log.ts";

const reservation = {
  id: "reservation-test-1",
  source: "naver",
  roomName: "머무룸2",
  customerName: "삭제기록 테스트",
  phone: "010-0000-0000",
  startTime: new Date("2026-07-31T03:00:00.000Z"),
  endTime: new Date("2026-07-31T06:00:00.000Z"),
  price: 50000,
  status: "CONFIRMED",
  usageLog: {
    id: "usage-test-1",
    reservationId: "reservation-test-1",
    headCount: 7,
  },
  messages: [
    {
      id: "message-test-1",
      reservationId: "reservation-test-1",
      status: "DELIVERED",
      body: "테스트 문자",
    },
  ],
};

const source = normalizeDeletionSource(
  "mobile-calendar",
  "test-user-agent",
);
const log = buildReservationDeletionLogData(reservation, source);

assert.equal(log.reservationId, reservation.id);
assert.equal(log.roomName, "머무룸2");
assert.equal(log.deletedFrom, "mobile-calendar | test-user-agent");
assert.equal(JSON.parse(log.reservationSnapshot).price, 50000);
assert.equal(JSON.parse(log.usageLogSnapshot).headCount, 7);
assert.equal(JSON.parse(log.messageSnapshot)[0].status, "DELIVERED");
assert.equal(JSON.parse(log.reservationSnapshot).usageLog, undefined);
assert.equal(JSON.parse(log.reservationSnapshot).messages, undefined);

console.log("reservation deletion log policy: OK");
