import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/reservation-notifications.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /function notificationReadyMemoWhere\(\)[\s\S]*?\{ memo: null \}[\s\S]*?contains: RPA_PENDING_MARKER/,
  "Reservations with a null memo must remain eligible while the RPA pending marker stays excluded.",
);

assert.equal(
  (source.match(/\.\.\.notificationReadyMemoWhere\(\)/g) || []).length,
  4,
  "The same null-safe memo condition must protect selection and every send claim.",
);

console.log("Reservation notification memo-filter tests passed.");
