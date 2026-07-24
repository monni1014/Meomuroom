import assert from "node:assert/strict";
import {
  expiryDateKeyKst,
  remainingKstCalendarDays,
  sessionExpiryAlertKey,
  sessionExpiryWarningDay,
} from "../src/lib/rpa-session-expiry-policy.ts";

const now = Date.parse("2026-08-19T00:00:00.000Z"); // 8/19 09:00 KST
const threeDaysLater = Date.parse("2026-08-22T09:29:17.000Z");

assert.equal(remainingKstCalendarDays(threeDaysLater, now), 3);
assert.equal(sessionExpiryWarningDay(threeDaysLater, now), 3);
assert.equal(sessionExpiryWarningDay(threeDaysLater, now + 24 * 60 * 60 * 1000), 2);
assert.equal(sessionExpiryWarningDay(threeDaysLater, now + 2 * 24 * 60 * 60 * 1000), 1);
assert.equal(sessionExpiryWarningDay(threeDaysLater, now - 24 * 60 * 60 * 1000), null);
assert.equal(expiryDateKeyKst(threeDaysLater), "2026-08-22");
assert.equal(
  sessionExpiryAlertKey("spacecloud", threeDaysLater, 3),
  "rpa-login-expiry:spacecloud:2026-08-22:3",
);

console.log("RPA session expiry warning policy tests passed.");
