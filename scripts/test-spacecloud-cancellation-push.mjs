import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSpaceCloudCancellationPush } from "../src/lib/spacecloud-cancellation-push-policy.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

assert.deepEqual(buildSpaceCloudCancellationPush({
  reservationId: "cancelled-with-fee",
  roomName: "머무룸2",
  customerName: "김머룸",
  startTime: new Date("2026-07-31T15:00:00+09:00"),
  endTime: new Date("2026-07-31T18:00:00+09:00"),
  cancellationFee: 24000,
}), {
  title: "스클 예약 취소",
  body: "머무룸2\n김머룸\n7월 31일 / 15시~18시\n취소수수료 24,000원",
  url: "/calendar?date=2026-07-31",
  tag: "spacecloud-cancellation-cancelled-with-fee",
});

assert.equal(
  buildSpaceCloudCancellationPush({
    reservationId: "cancelled-without-fee",
    roomName: "머무룸1",
    customerName: null,
    startTime: new Date("2026-08-01T09:30:00+09:00"),
    endTime: new Date("2026-08-01T11:00:00+09:00"),
    cancellationFee: 0,
  }).body,
  "머무룸1\n이름 없음\n8월 1일 / 9시 30분~11시\n취소수수료 없음",
);

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

const queueSource = await readFile(
  new URL("../src/lib/rpa-job-queue.ts", import.meta.url),
  "utf8",
);
const rpaIndex = queueSource.indexOf("result = await processSpaceCloudEmailWithRpa(job)");
const cancellationPushIndex = queueSource.indexOf(
  "await sendSpaceCloudCancellationPush(result.reservationId",
);
const processedIndex = queueSource.indexOf("await markEmailProcessed(job.messageId", cancellationPushIndex);
assert.ok(rpaIndex >= 0, "SpaceCloud cancellation must first run the host-center RPA");
assert.ok(
  cancellationPushIndex > rpaIndex,
  "SpaceCloud cancellation push must run only after the host-center RPA",
);
assert.ok(
  processedIndex > cancellationPushIndex,
  "SpaceCloud cancellation push must complete before the email is finalized for crash recovery",
);
assert.match(
  queueSource,
  /cancellationFeeVerified: result\.cancellationFeeVerified === true/,
  "SpaceCloud cancellation push must require an explicit fee-verification result",
);

const pushSource = await readFile(
  new URL("../src/lib/spacecloud-cancellation-push.ts", import.meta.url),
  "utf8",
);
assert.match(
  pushSource,
  /if \(!options\.cancellationFeeVerified\)/,
  "the push sender must reject unverified cancellation fees",
);
assert.match(
  pushSource,
  /excludeAppleWebPush: true/,
  "SpaceCloud cancellation push must exclude Apple web push subscriptions",
);

console.log("SpaceCloud cancellation push tests passed.");
