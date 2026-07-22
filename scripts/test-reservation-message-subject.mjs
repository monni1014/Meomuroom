import assert from "node:assert/strict";
import { reservationMessageSubject } from "../src/lib/reservation-message-subject.ts";

assert.equal(reservationMessageSubject("머무룸1"), "머무룸1 3층 안내");
assert.equal(reservationMessageSubject("머무룸2 - 4층"), "머무룸2 4층 안내");
assert.equal(reservationMessageSubject("머무룸3"), "머무룸3 지하1층 안내");
assert.equal(reservationMessageSubject("미지정 공간"), "머무룸 이용 안내");

console.log("Reservation message subject tests passed.");
