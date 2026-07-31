import { strict as assert } from "node:assert";
import { decorateDashboardCalendarScheduleEvents } from "../src/lib/dashboard-calendar-schedule-events.ts";

const dayStart = new Date("2026-07-31T00:00:00+09:00");
const dayEnd = new Date("2026-07-31T23:59:59.999+09:00");

const events = decorateDashboardCalendarScheduleEvents([
  {
    id: "created-today",
    createdAt: new Date("2026-07-31T09:00:00+09:00"),
    updatedAt: new Date("2026-07-31T09:00:00+09:00"),
  },
  {
    id: "updated-today",
    createdAt: new Date("2026-07-30T09:00:00+09:00"),
    updatedAt: new Date("2026-07-31T12:00:00+09:00"),
  },
  {
    id: "created-and-updated-today",
    createdAt: new Date("2026-07-31T10:00:00+09:00"),
    updatedAt: new Date("2026-07-31T13:00:00+09:00"),
  },
  {
    id: "unchanged-old",
    createdAt: new Date("2026-07-29T09:00:00+09:00"),
    updatedAt: new Date("2026-07-29T09:00:00+09:00"),
  },
], dayStart, dayEnd);

assert.deepEqual(events.map((event) => event.id), [
  "created-and-updated-today",
  "updated-today",
  "created-today",
]);
assert.equal(events[0].dashboardEventType, "UPDATED_TODAY");
assert.equal(events[1].dashboardEventType, "UPDATED_TODAY");
assert.equal(events[2].dashboardEventType, "CREATED_TODAY");

console.log("dashboard calendar schedule event tests passed");
