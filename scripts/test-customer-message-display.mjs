import assert from "node:assert/strict";
import { customerMessageDisplay } from "../src/lib/customer-message-display.ts";

assert.deepEqual(
  customerMessageDisplay("reservation-reminder:reservation-1"),
  { type: "GUIDE", label: "이용 안내" },
);
assert.deepEqual(
  customerMessageDisplay("situation:dawn-booking:reservation-1"),
  { type: "DAWN_BOOKING", label: "새벽시간 확인" },
);
assert.deepEqual(
  customerMessageDisplay("situation:on-time-exit:reservation-1"),
  { type: "ON_TIME_EXIT", label: "정시퇴실 안내" },
);
assert.deepEqual(
  customerMessageDisplay("situation:unpaid:reservation-1"),
  { type: "UNPAID", label: "미정산 안내" },
);
assert.deepEqual(
  customerMessageDisplay("situation:custom:reservation-1"),
  { type: "SITUATION", label: "상황별 안내" },
);

console.log("Customer message display tests passed.");
