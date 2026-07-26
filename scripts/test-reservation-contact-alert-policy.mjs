import assert from "node:assert/strict";
import {
  AUTOMATED_CONTACT_GRACE_MS,
  hasContactAlertGraceElapsed,
} from "../src/lib/reservation-contact-alert-policy.ts";

const createdAt = new Date("2026-07-26T07:49:16.000Z");

assert.equal(
  hasContactAlertGraceElapsed(
    "spacecloud",
    createdAt,
    new Date(createdAt.getTime() + AUTOMATED_CONTACT_GRACE_MS - 1),
  ),
  false,
  "SpaceCloud contact collection must have a full five-minute grace period.",
);
assert.equal(
  hasContactAlertGraceElapsed(
    "spacecloud",
    createdAt,
    new Date(createdAt.getTime() + AUTOMATED_CONTACT_GRACE_MS),
  ),
  true,
);
assert.equal(
  hasContactAlertGraceElapsed(
    "naver",
    createdAt,
    new Date(createdAt.getTime() + AUTOMATED_CONTACT_GRACE_MS),
  ),
  true,
);
assert.equal(
  hasContactAlertGraceElapsed("manual", createdAt, createdAt),
  true,
  "Manual reservations keep their existing immediate same-day warning behavior.",
);

console.log("Reservation contact alert policy tests passed.");
