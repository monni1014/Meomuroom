import assert from "node:assert/strict";
import { buildManualReservationPush } from "../src/lib/manual-reservation-push.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

const push = buildManualReservationPush({
  id: "reservation-1",
  roomName: "머무룸2",
  customerName: "김혜수",
  startTime: new Date("2026-07-26T10:00:00.000Z"),
  endTime: new Date("2026-07-26T13:00:00.000Z"),
});

assert.deepEqual(push, {
  title: "수기 예약 추가",
  body: "머무룸2\n김혜수\n7월 26일 19:00~22:00",
  url: "/calendar?date=2026-07-26",
  tag: "manual-reservation-reservation-1",
});

const subscriptions = ["origin", "iphone", "desktop"].map((name) => ({
  endpoint: `https://push.example/${name}`,
  expirationTime: null,
  keys: { p256dh: `${name}-key`, auth: `${name}-auth` },
  createdAt: "2026-07-26T00:00:00.000Z",
  lastSeenAt: "2026-07-26T00:00:00.000Z",
}));

assert.deepEqual(
  selectPushSubscriptions(subscriptions, {
    excludeEndpoints: ["https://push.example/origin"],
  }).map((subscription) => subscription.endpoint),
  ["https://push.example/iphone", "https://push.example/desktop"],
);

console.log("Manual reservation push tests passed.");
