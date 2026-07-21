import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveCancellationOperationalTimes } from "../src/lib/reservation-operational-time.ts";

const existingOperationalRange = {
  startTime: new Date("2026-08-29T12:00:00+09:00"),
  endTime: new Date("2026-08-29T19:00:00+09:00"),
};
const incomingNaverRange = {
  startTime: new Date("2026-08-29T13:00:00+09:00"),
  endTime: new Date("2026-08-29T18:00:00+09:00"),
};

const preserved = resolveCancellationOperationalTimes(existingOperationalRange, incomingNaverRange);
assert.equal(preserved.startTime.toISOString(), existingOperationalRange.startTime.toISOString());
assert.equal(preserved.endTime.toISOString(), existingOperationalRange.endTime.toISOString());

const fallback = resolveCancellationOperationalTimes(null, incomingNaverRange);
assert.equal(fallback.startTime.toISOString(), incomingNaverRange.startTime.toISOString());
assert.equal(fallback.endTime.toISOString(), incomingNaverRange.endTime.toISOString());

const syncSource = await readFile(new URL("../src/lib/naver-rpa-sync.ts", import.meta.url), "utf8");
const cancellationStart = syncSource.indexOf("async function cancelNaverReservation");
const cancellationEnd = syncSource.indexOf("function canSetSlot", cancellationStart);
assert.ok(cancellationStart >= 0 && cancellationEnd > cancellationStart);
const cancellationSource = syncSource.slice(cancellationStart, cancellationEnd);
assert.match(cancellationSource, /resolveCancellationOperationalTimes\(existing, item\)/);
assert.match(cancellationSource, /startTime: operationalTimes\.startTime/);
assert.match(cancellationSource, /endTime: operationalTimes\.endTime/);
assert.doesNotMatch(cancellationSource, /preserveOperationalTime/);

console.log("Naver cancellation operational-time tests passed.");
