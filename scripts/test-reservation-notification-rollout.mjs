import assert from "node:assert/strict";
import {
  isReservationAutoSendActive,
  reservationNotificationRolloutStartsAt,
} from "../src/lib/reservation-notification-rollout.ts";

const rollout = "2026-07-24T15:00:00.000Z";

assert.equal(
  reservationNotificationRolloutStartsAt(rollout)?.toISOString(),
  rollout,
);
assert.equal(
  isReservationAutoSendActive(new Date("2026-07-24T14:59:59.999Z"), rollout),
  false,
);
assert.equal(
  isReservationAutoSendActive(new Date("2026-07-24T15:00:00.000Z"), rollout),
  true,
);
assert.equal(isReservationAutoSendActive(new Date(), ""), true);
assert.equal(isReservationAutoSendActive(new Date(), "invalid-date"), false);

console.log("Reservation notification rollout tests passed.");
