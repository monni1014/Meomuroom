import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveRpaReservationPhone } from "../src/lib/reservation-phone-lock.ts";

assert.equal(
  resolveRpaReservationPhone({ phone: "010-1111-2222", phoneLocked: false }, "010-3333-4444"),
  "010-3333-4444",
);
assert.equal(
  resolveRpaReservationPhone({ phone: "010-1111-2222", phoneLocked: true }, "010-3333-4444"),
  "010-1111-2222",
);
assert.equal(
  resolveRpaReservationPhone({ phone: "010-1111-2222", phoneLocked: false }, null),
  "010-1111-2222",
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
assert.match(naverSource, /resolveRpaReservationPhone\(existing, item\.phone\)/);
assert.match(spacecloudSource, /resolveRpaReservationPhone\(existing, item\.phone\)/);

console.log("Reservation phone-lock tests passed.");
