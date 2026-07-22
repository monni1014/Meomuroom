import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/reservation-notifications.ts", import.meta.url),
  "utf8",
);
const instrumentationSource = await readFile(
  new URL("../src/instrumentation.node.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /function notificationReadyMemoWhere\(\)[\s\S]*?\{ memo: null \}[\s\S]*?contains: RPA_PENDING_MARKER/,
  "Reservations with a null memo must remain eligible while the RPA pending marker stays excluded.",
);

assert.equal(
  (source.match(/\.\.\.notificationReadyMemoWhere\(\)/g) || []).length,
  3,
  "The same null-safe memo condition must protect selection, contact waiting, and the send claim.",
);

assert.doesNotMatch(
  source,
  /contactSyncError\s*\?\s*\[\]\s*:\s*phoneReadyReservations/,
  "A Google Contacts failure must not suppress SMS delivery when the phone number is valid.",
);

assert.match(
  source,
  /if \(contactSyncError\)[\s\S]*?createAdminAlert\([\s\S]*?GOOGLE_PEOPLE_SYNC_FAILED[\s\S]*?for \(const reservation of phoneReadyReservations\)/,
  "Google Contacts failures must raise an alert before SMS delivery continues.",
);

assert.match(
  instrumentationSource,
  /schedule\("\*\/5 \* \* \* \*"[\s\S]*?runGooglePeopleSync\("cron"\)/,
  "Google Contacts synchronization must keep retrying every five minutes.",
);

console.log("Reservation notification safety tests passed.");
