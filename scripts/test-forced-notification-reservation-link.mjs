import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routeSource = await readFile(
  new URL("../src/app/api/notifications/test/route.ts", import.meta.url),
  "utf8",
);
const messageSource = await readFile(
  new URL("../src/lib/customer-messages.ts", import.meta.url),
  "utf8",
);
const solapiSource = await readFile(
  new URL("../src/lib/solapi-sms.ts", import.meta.url),
  "utf8",
);
const webhookSource = await readFile(
  new URL("../src/lib/solapi-webhook.ts", import.meta.url),
  "utf8",
);
const messagesPageSource = await readFile(
  new URL("../src/app/messages/page.tsx", import.meta.url),
  "utf8",
);

assert.match(
  routeSource,
  /if \(!reservationId\)[\s\S]*?강제 테스트 발송은 연결할 예약을 반드시 선택해야 합니다/,
  "A forced test must be rejected when no reservation is selected.",
);
assert.match(
  routeSource,
  /requestedTo !== reservationPhone[\s\S]*?테스트 수신번호는 선택한 예약의 고객 전화번호와 같아야 합니다/,
  "A forced test must not be attached to a reservation with a different phone number.",
);

const reservationLookupIndex = routeSource.indexOf("prisma.reservation.findUnique");
const attemptRecordIndex = routeSource.indexOf("recordOutboundTestMessage({");
const providerSendIndex = routeSource.indexOf("sendTestSms(");
assert.ok(reservationLookupIndex >= 0 && reservationLookupIndex < attemptRecordIndex);
assert.ok(attemptRecordIndex >= 0 && attemptRecordIndex < providerSendIndex);

assert.match(
  routeSource,
  /notification\.sendAttempt\.\$\{reservation\.id\}[\s\S]*?kind: "FORCED_TEST"/,
  "The recovery attempt must be persisted before the provider call.",
);
assert.match(
  routeSource,
  /recordOutboundTestMessage\(\{[\s\S]*?reservationId: reservation\.id[\s\S]*?notificationAttemptId[\s\S]*?status: "SENDING"/,
  "The DB message must be linked to the reservation before Solapi is called.",
);
assert.match(
  routeSource,
  /forceRealSend: realSend, forceDryRun: !realSend/,
  "A non-real test request must remain a dry run even for allowlisted phone numbers.",
);
assert.match(
  messageSource,
  /reservation-test:\$\{reservationId\}:\$\{notificationAttemptId\}/,
  "Each forced test needs a unique reservation-linked dedupe key.",
);
assert.match(
  solapiSource,
  /reservationId: options\.reservationId[\s\S]*?notificationAttemptId: options\.notificationAttemptId/,
  "The reservation and attempt identifiers must be forwarded to Solapi custom fields.",
);
assert.ok(
  webhookSource.indexOf("reservationTestMessageDedupeKey")
    < webhookSource.indexOf("where: { direction: \"OUTBOUND\", reservationId }"),
  "Webhook matching must prefer the exact forced-test attempt before reservation fallback.",
);
assert.match(messagesPageSource, /dedupeKey\.startsWith\("reservation-test:"\)/);

console.log("Forced notification reservation-link tests passed.");
