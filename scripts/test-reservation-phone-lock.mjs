import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveRpaReservationPhoneState,
  shouldLockManuallyEditedPhone,
} from "../src/lib/reservation-phone-lock.ts";

assert.deepEqual(
  resolveRpaReservationPhoneState(
    { phone: "010-1111-2222", syncedPhone: "010-1111-2222", phoneLocked: false },
    "010-3333-4444",
  ),
  { phone: "010-3333-4444", syncedPhone: "010-3333-4444", phoneLocked: false },
);
assert.deepEqual(
  resolveRpaReservationPhoneState(
    { phone: "010-1111-2222", syncedPhone: "010-3333-4444", phoneLocked: true },
    "010-3333-4444",
  ),
  { phone: "010-1111-2222", syncedPhone: "010-3333-4444", phoneLocked: true },
);
assert.deepEqual(
  resolveRpaReservationPhoneState(
    { phone: "010-3333-4444", syncedPhone: "010-1111-2222", phoneLocked: true },
    "010-3333-4444",
  ),
  { phone: "010-3333-4444", syncedPhone: "010-3333-4444", phoneLocked: false },
);
assert.equal(
  shouldLockManuallyEditedPhone(
    { phone: "010-3333-4444", syncedPhone: "010-1111-2222", phoneLocked: true },
    "01011112222",
  ),
  false,
);
assert.equal(
  shouldLockManuallyEditedPhone(
    { phone: "010-1111-2222", syncedPhone: "010-1111-2222", phoneLocked: false },
    "010-5555-6666",
  ),
  true,
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

assert.match(routeSource, /changedFields\.includes\("phone"\)[\s\S]*?updateData\.phoneLocked/);
assert.match(routeSource, /shouldLockManuallyEditedPhone\(existing/);
assert.match(naverSource, /resolveRpaReservationPhoneState\(existing, item\.phone\)/);
assert.match(spacecloudSource, /resolveRpaReservationPhoneState\(existing, item\.phone\)/);

console.log("Reservation phone-lock tests passed.");
