import assert from "node:assert/strict";
import { shouldCreateBookingDiscoveryEvent } from "../src/lib/competitor-booking-discovery.ts";

assert.equal(shouldCreateBookingDiscoveryEvent("AVAILABLE", undefined), false);
assert.equal(shouldCreateBookingDiscoveryEvent("BOOKED", undefined), true);
assert.equal(
  shouldCreateBookingDiscoveryEvent("BOOKED", { state: "AVAILABLE", lastBookedAt: null }),
  true,
);
assert.equal(
  shouldCreateBookingDiscoveryEvent("BOOKED", { state: "UNKNOWN", lastBookedAt: null }),
  true,
);
assert.equal(
  shouldCreateBookingDiscoveryEvent("BOOKED", { state: "NOT_YET_OPEN", lastBookedAt: null }),
  true,
);
assert.equal(
  shouldCreateBookingDiscoveryEvent("BOOKED", { state: "BOOKED", lastBookedAt: null }),
  true,
  "Legacy baseline bookings must produce one discovery event when revisited.",
);
assert.equal(
  shouldCreateBookingDiscoveryEvent("BOOKED", {
    state: "BOOKED",
    lastBookedAt: new Date("2026-07-26T00:00:00.000Z"),
  }),
  false,
  "A booking with an existing discovery timestamp must not alert twice.",
);

console.log("Competitor booking discovery tests passed.");
