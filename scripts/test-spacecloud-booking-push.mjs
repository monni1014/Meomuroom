import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSpaceCloudBookingPush } from "../src/lib/spacecloud-booking-push-policy.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

assert.deepEqual(buildSpaceCloudBookingPush({
  reservationId: "reservation-1",
  roomName: "머무룸3",
  customerName: "정윤희",
  startTime: new Date("2026-07-29T13:00:00+09:00"),
  endTime: new Date("2026-07-29T16:00:00+09:00"),
  headCount: 10,
  price: 75000,
}), {
  title: "스클 신규 예약",
  body: "머무룸3\n정윤희\n7월 29일 / 13시~16시\n인원 10명 · 매출액 75,000원",
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

const emailSyncSource = await readFile(
  new URL("../src/lib/email-sync.ts", import.meta.url),
  "utf8",
);
const immediatePushIndex = emailSyncSource.indexOf(
  "await sendSpaceCloudBookingPush(pending.id)",
);
const queueIndex = emailSyncSource.indexOf("rpaJobs.push({", immediatePushIndex);
assert.ok(immediatePushIndex >= 0, "SpaceCloud booking push must run during email ingestion");
assert.ok(
  queueIndex > immediatePushIndex,
  "SpaceCloud booking push must run before the detail RPA job is queued",
);
assert.match(
  emailSyncSource,
  /reservationData\.source === "spacecloud" && !reservationData\.isCancelled/,
  "only confirmed SpaceCloud booking emails should trigger the immediate push",
);

const queueSource = await readFile(
  new URL("../src/lib/rpa-job-queue.ts", import.meta.url),
  "utf8",
);
assert.match(
  queueSource,
  /await sendSpaceCloudBookingPush\(result\.reservationId\)/,
  "post-RPA push retry must remain as a deduplicated safety net",
);

console.log("SpaceCloud booking push tests passed.");
