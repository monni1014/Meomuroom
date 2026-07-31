import assert from "node:assert/strict";
import { decorateDashboardReservationEvents } from "../src/lib/dashboard-reservation-events.ts";
import { resolveReservationCancellationState } from "../src/lib/reservation-cancellation.ts";

const dayStart = new Date("2026-07-31T00:00:00.000+09:00");
const dayEnd = new Date("2026-07-31T23:59:59.999+09:00");
const cancelledToday = new Date("2026-07-31T13:30:00.000+09:00");

assert.deepEqual(
  resolveReservationCancellationState(
    { status: "CONFIRMED", cancelledAt: null },
    "CANCELLED",
    cancelledToday,
  ),
  { cancelledAt: cancelledToday },
  "확정 예약이 취소되면 최초 취소 시각을 기록해야 합니다.",
);

const originalCancellation = new Date("2026-07-30T12:00:00.000+09:00");
assert.deepEqual(
  resolveReservationCancellationState(
    { status: "CANCELLED", cancelledAt: originalCancellation },
    "CANCELLED",
    cancelledToday,
  ),
  { cancelledAt: originalCancellation },
  "같은 취소를 다시 처리해도 취소 시각이 오늘로 바뀌면 안 됩니다.",
);

assert.deepEqual(
  resolveReservationCancellationState(
    { status: "CANCELLED", cancelledAt: originalCancellation },
    "CONFIRMED",
    cancelledToday,
  ),
  { cancelledAt: null },
  "취소 예약을 되살리면 취소 시각을 비워야 합니다.",
);

const events = decorateDashboardReservationEvents([
  {
    id: "old-cancelled-today",
    createdAt: new Date("2026-07-30T10:00:00.000+09:00"),
    cancelledAt: cancelledToday,
  },
  {
    id: "created-today",
    createdAt: new Date("2026-07-31T09:00:00.000+09:00"),
    cancelledAt: null,
  },
], dayStart, dayEnd);

assert.equal(events[0].id, "old-cancelled-today", "오늘 취소가 발생 시각 기준으로 정렬돼야 합니다.");
assert.equal(events[0].dashboardEventType, "CANCELLED_TODAY");
assert.equal(events[1].dashboardEventType, "CREATED_TODAY");

console.log("dashboard cancellation event tests passed");
