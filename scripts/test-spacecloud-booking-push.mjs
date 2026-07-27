import assert from "node:assert/strict";
import { buildSpaceCloudBookingPush } from "../src/lib/spacecloud-booking-push-policy.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

assert.deepEqual(buildSpaceCloudBookingPush({
  reservationId: "reservation-1",
  roomName: "머무룸3",
  customerName: "정윤희",
  startTime: new Date("2026-07-29T13:00:00+09:00"),
  endTime: new Date("2026-07-29T16:00:00+09:00"),
}), {
  title: "스클 신규 예약",
  body: "머무룸3\n정윤희\n7월 29일 / 13시~16시",
  url: "/calendar?date=2026-07-29",
  tag: "spacecloud-booking-reservation-1",
});

const subscriptions = [
  { endpoint: "https://web.push.apple.com/iphone" },
  { endpoint: "https://fcm.googleapis.com/fcm/send/galaxy" },
  { endpoint: "https://push.example/desktop" },
];
assert.deepEqual(
  selectPushSubscriptions(subscriptions, { excludeAppleWebPush: true }).map(({ endpoint }) => endpoint),
  [
    "https://fcm.googleapis.com/fcm/send/galaxy",
    "https://push.example/desktop",
  ],
);

console.log("SpaceCloud booking push tests passed.");
