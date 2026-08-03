import assert from "node:assert/strict";
import {
  buildSynergyBookingPushes,
  buildSynergySpacecloudPushes,
  detectSynergyOneHourReschedules,
  shouldSuppressSynergyNewBookingPush,
} from "../src/lib/competitor-booking-push-policy.ts";
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
    body: "7월 30일 / 15시~18시",
    url: "/competitors?year=2026&month=7",
    tag: "competitor-synergy-booked-2026-07-30-15-18",
  },
  {
    title: "시너지 신규 예약 발견",
    body: "7월 30일 / 20시~21시",
    url: "/competitors?year=2026&month=7",
    tag: "competitor-synergy-booked-2026-07-30-20-21",
  },
]);

assert.deepEqual(buildSynergyBookingPushes([
  { scanId: "scan-move", competitorId: "synergy", dateKey: "2026-07-31", hour: 12, eventType: "BOOKED" },
  { scanId: "scan-move", competitorId: "synergy", dateKey: "2026-07-31", hour: 14, eventType: "CANCELLED" },
]), [{
  title: "시너지 예약 시간 변경 추정",
  body: "7월 31일 / 13시~15시 → 12시~14시",
  url: "/competitors?year=2026&month=7",
  tag: "competitor-synergy-rescheduled-2026-07-31-13-15-12-14",
}]);

assert.deepEqual(detectSynergyOneHourReschedules([
  {
    key: "booked-edge",
    scanId: "scan-a",
    competitorId: "synergy",
    dateKey: "2026-07-31",
    eventType: "BOOKED",
    startHour: 12,
    endHour: 13,
  },
  {
    key: "cancelled-edge",
    scanId: "scan-b",
    competitorId: "synergy",
    dateKey: "2026-07-31",
    eventType: "CANCELLED",
    startHour: 14,
    endHour: 15,
  },
]), [], "changes from separate scans must not be merged");

assert.deepEqual(buildSynergyBookingPushes([
  { scanId: "scan-independent", competitorId: "synergy", dateKey: "2026-08-01", hour: 8, eventType: "BOOKED" },
  { scanId: "scan-independent", competitorId: "synergy", dateKey: "2026-08-01", hour: 9, eventType: "BOOKED" },
  { scanId: "scan-independent", competitorId: "synergy", dateKey: "2026-08-01", hour: 14, eventType: "CANCELLED" },
  { scanId: "scan-independent", competitorId: "synergy", dateKey: "2026-08-01", hour: 15, eventType: "CANCELLED" },
]), [{
  title: "시너지 신규 예약 발견",
  body: "8월 1일 / 8시~10시",
  url: "/competitors?year=2026&month=8",
  tag: "competitor-synergy-booked-2026-08-01-8-10",
}], "independent two-hour changes must remain new/cancel events");

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

assert.deepEqual(buildSynergySpacecloudPushes([
  { scanId: "scan-sc", competitorId: "synergy-spacecloud", dateKey: "2026-08-03", hour: 13, eventType: "BOOKED" },
  { scanId: "scan-sc", competitorId: "synergy-spacecloud", dateKey: "2026-08-03", hour: 14, eventType: "BOOKED" },
  { scanId: "scan-sc", competitorId: "synergy-spacecloud", dateKey: "2026-08-04", hour: 18, eventType: "CANCELLED", cancellationFeeRate: 70 },
  { scanId: "scan-sc", competitorId: "synergy-spacecloud", dateKey: "2026-08-04", hour: 19, eventType: "CANCELLED", cancellationFeeRate: 70 },
]), [
  {
    title: "시너지 스클 신규 예약",
    body: "8월 3일 / 13시~15시",
    url: "/competitors?year=2026&month=8",
    tag: "competitor-synergy-spacecloud-booked-2026-08-03-13-15",
  },
  {
    title: "시너지 스클 예약 취소",
    body: "8월 4일 / 18시~20시 · 취소수수료 70%",
    url: "/competitors?year=2026&month=8",
    tag: "competitor-synergy-spacecloud-cancelled-2026-08-04-18-20",
  },
]);

const augustKst = new Date("2026-08-03T03:00:00.000Z");
assert.equal(
  shouldSuppressSynergyNewBookingPush(
    { tag: "competitor-synergy-booked-2026-08-03-13-15" },
    augustKst,
  ),
  true,
  "Synergy Naver new booking pushes must be paused during August KST",
);
assert.equal(
  shouldSuppressSynergyNewBookingPush(
    { tag: "competitor-synergy-spacecloud-booked-2026-08-03-13-15" },
    augustKst,
  ),
  true,
  "Synergy SpaceCloud new booking pushes must be paused during August KST",
);
assert.equal(
  shouldSuppressSynergyNewBookingPush(
    { tag: "competitor-synergy-rescheduled-2026-08-03-14-16-13-15" },
    augustKst,
  ),
  false,
  "Synergy reschedule alerts must remain enabled",
);
assert.equal(
  shouldSuppressSynergyNewBookingPush(
    { tag: "competitor-synergy-spacecloud-cancelled-2026-08-03-13-15" },
    augustKst,
  ),
  false,
  "Synergy SpaceCloud cancellation alerts must remain enabled",
);
assert.equal(
  shouldSuppressSynergyNewBookingPush(
    { tag: "competitor-synergy-booked-2026-09-01-13-15" },
    new Date("2026-08-31T15:00:00.000Z"),
  ),
  false,
  "Synergy new booking pushes must resume at 2026-09-01 00:00 KST",
);

console.log("Competitor booking push tests passed.");
