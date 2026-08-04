import assert from "node:assert/strict";
import { selectReservationMatch } from "../src/lib/rpa-reservation-match-policy.ts";

const startTime = new Date("2026-08-10T02:00:00.000Z");
const endTime = new Date("2026-08-10T05:00:00.000Z");

function candidate(overrides = {}) {
  return {
    id: "candidate",
    emailId: null,
    source: "naver",
    roomName: "머무룸2",
    customerName: "이지수",
    startTime,
    endTime,
    status: "CONFIRMED",
    ...overrides,
  };
}

const newBookingInput = {
  source: "naver",
  messageId: "new-message",
  canonicalEmailId: "naver:1312961510",
  roomName: "머무룸2",
  customerName: "이지수",
  startTime,
  endTime,
  isCancelled: false,
};

const oldCancelled = candidate({
  id: "old-cancelled",
  emailId: "naver:1312866742",
  status: "CANCELLED",
});
const newPending = candidate({ id: "new-pending", emailId: "new-message" });

assert.equal(
  selectReservationMatch([oldCancelled, newPending], newBookingInput)?.id,
  "new-pending",
  "A new booking must use its pending row instead of reviving an older cancelled booking.",
);
assert.equal(
  selectReservationMatch([oldCancelled], newBookingInput),
  null,
  "A new booking must create a separate row when only an older cancelled booking exists.",
);

const spaceCloudCancellationInput = {
  source: "spacecloud",
  messageId: "spacecloud-cancel-message",
  roomName: "머무룸3",
  customerName: "방송기자연합회",
  startTime,
  endTime,
  isCancelled: true,
  allowUniqueCrossRoomCancellation: true,
};
const correctRoom = candidate({
  id: "spacecloud-room2",
  source: "spacecloud",
  roomName: "머무룸2",
  customerName: "방송기자연합회",
  emailId: "spacecloud:10396010",
});

assert.equal(
  selectReservationMatch([correctRoom], spaceCloudCancellationInput),
  null,
  "A confirmed SpaceCloud reservation in another room must never be guessed as the cancellation target.",
);
assert.equal(
  selectReservationMatch([
    { ...correctRoom, status: "CANCELLED", memo: "[RPA_PENDING] cancellation" },
  ], spaceCloudCancellationInput)?.id,
  "spacecloud-room2",
  "A SpaceCloud cancellation row already marked pending must remain matchable during detail RPA.",
);
assert.equal(
  selectReservationMatch([
    correctRoom,
    candidate({
      id: "ambiguous-room1",
      source: "spacecloud",
      roomName: "머무룸1",
      customerName: "방송기자연합회",
    }),
  ], spaceCloudCancellationInput),
  null,
  "An ambiguous cross-room cancellation must never be guessed.",
);

console.log("RPA reservation match policy tests passed");
