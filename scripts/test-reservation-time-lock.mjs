import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveRpaReservationTimeState,
  shouldLockManuallyEditedTime,
} from "../src/lib/reservation-time-lock.ts";

const at = (hour) => new Date(`2026-07-26T${String(hour).padStart(2, "0")}:00:00+09:00`);

assert.deepEqual(
  resolveRpaReservationTimeState(
    {
      startTime: at(9),
      endTime: at(10),
      syncedStartTime: at(9),
      syncedEndTime: at(10),
      timeLocked: false,
    },
    at(11),
    at(12),
  ),
  {
    startTime: at(11),
    endTime: at(12),
    syncedStartTime: at(11),
    syncedEndTime: at(12),
    timeLocked: false,
  },
);

assert.deepEqual(
  resolveRpaReservationTimeState(
    {
      startTime: at(13),
      endTime: at(16),
      syncedStartTime: at(1),
      syncedEndTime: at(4),
      timeLocked: true,
    },
    at(1),
    at(4),
  ),
  {
    startTime: at(13),
    endTime: at(16),
    syncedStartTime: at(1),
    syncedEndTime: at(4),
    timeLocked: true,
  },
);

assert.deepEqual(
  resolveRpaReservationTimeState(
    {
      startTime: at(13),
      endTime: at(16),
      syncedStartTime: at(1),
      syncedEndTime: at(4),
      timeLocked: true,
    },
    at(13),
    at(16),
  ),
  {
    startTime: at(13),
    endTime: at(16),
    syncedStartTime: at(13),
    syncedEndTime: at(16),
    timeLocked: false,
  },
);

assert.deepEqual(
  resolveRpaReservationTimeState(
    {
      startTime: at(13),
      endTime: at(16),
      syncedStartTime: null,
      syncedEndTime: null,
      timeLocked: false,
    },
    at(1),
    at(4),
  ),
  {
    startTime: at(13),
    endTime: at(16),
    syncedStartTime: at(1),
    syncedEndTime: at(4),
    timeLocked: true,
  },
);

assert.equal(
  shouldLockManuallyEditedTime(
    {
      startTime: at(1),
      endTime: at(4),
      syncedStartTime: at(1),
      syncedEndTime: at(4),
      timeLocked: false,
    },
    at(13),
    at(16),
  ),
  true,
);

assert.equal(
  shouldLockManuallyEditedTime(
    {
      startTime: at(13),
      endTime: at(16),
      syncedStartTime: at(1),
      syncedEndTime: at(4),
      timeLocked: true,
    },
    at(1),
    at(4),
  ),
  false,
);

const routeSource = await readFile(
  new URL("../src/app/api/reservations/[id]/route.ts", import.meta.url),
  "utf8",
);
const naverSource = await readFile(
  new URL("../src/lib/naver-rpa-sync.ts", import.meta.url),
  "utf8",
);
const spacecloudSource = await readFile(
  new URL("../src/lib/spacecloud-rpa-sync.ts", import.meta.url),
  "utf8",
);

assert.match(routeSource, /changedFields\.some\([\s\S]*?updateData\.timeLocked/);
assert.match(routeSource, /shouldLockManuallyEditedTime\(existing, parsedStartTime, parsedEndTime\)/);
assert.match(naverSource, /resolveRpaReservationTimeState\(existing, item\.startTime, item\.endTime\)/);
assert.match(spacecloudSource, /resolveRpaReservationTimeState\(existing, item\.startTime, item\.endTime\)/);
assert.match(naverSource, /syncedStartTime: item\.startTime/);
assert.match(spacecloudSource, /syncedStartTime: item\.startTime/);

console.log("Reservation time-lock tests passed.");
