import assert from "node:assert/strict";
import { buildSynergyBookingPushes } from "../src/lib/competitor-booking-push-policy.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

const pushes = buildSynergyBookingPushes([
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 15, eventType: "BOOKED" },
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 16, eventType: "BOOKED" },
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 17, eventType: "BOOKED" },
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 20, eventType: "BOOKED" },
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 20, eventType: "BOOKED" },
  { competitorId: "triground-a", dateKey: "2026-07-30", hour: 12, eventType: "BOOKED" },
  { competitorId: "synergy", dateKey: "2026-07-30", hour: 21, eventType: "CANCELLED" },
]);

assert.deepEqual(pushes, [
  {
    title: "시너지 신규 예약 발견",
    body: "7월 30일 / 15시부터 18시까지",
    url: "/competitors?year=2026&month=7",
    tag: "competitor-synergy-booked-2026-07-30-15-18",
  },
  {
    title: "시너지 신규 예약 발견",
    body: "7월 30일 / 20시부터 21시까지",
    url: "/competitors?year=2026&month=7",
    tag: "competitor-synergy-booked-2026-07-30-20-21",
  },
]);

const subscriptions = [
  { endpoint: "https://web.push.apple.com/example" },
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

console.log("Competitor booking push tests passed.");
