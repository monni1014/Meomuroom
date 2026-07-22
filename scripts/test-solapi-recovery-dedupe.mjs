import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findReservationReminderInSolapiHistory } from "../src/lib/solapi-delivery-status.ts";

const messages = [
  {
    messageId: "old-message",
    to: "010-1111-2222",
    from: "010-9443-1849",
    text: "old",
    statusCode: "4000",
    dateCreated: "2026-07-22T00:00:00.000Z",
    customFields: {
      reservationId: "reservation-1",
      notificationAttemptId: "attempt-old",
    },
  },
  {
    messageId: "current-message",
    to: "01011112222",
    from: "01094431849",
    text: "current",
    statusCode: "2000",
    dateCreated: "2026-07-22T01:00:00.000Z",
    customFields: {
      reservationId: "reservation-1",
      notificationAttemptId: "attempt-current",
    },
  },
];

const currentAttempt = findReservationReminderInSolapiHistory(messages, {
  reservationId: "reservation-1",
  notificationAttemptId: "attempt-current",
  phone: "010-1111-2222",
});
assert.equal(currentAttempt.found, true);
assert.equal(currentAttempt.providerMessageId, "current-message");
assert.equal(currentAttempt.status, "SUBMITTED");

const oldAttempt = findReservationReminderInSolapiHistory(messages, {
  reservationId: "reservation-1",
  notificationAttemptId: "attempt-old",
  phone: "01011112222",
});
assert.equal(oldAttempt.found, true);
assert.equal(oldAttempt.providerMessageId, "old-message");
assert.equal(oldAttempt.status, "DELIVERED");

assert.deepEqual(findReservationReminderInSolapiHistory(messages, {
  reservationId: "reservation-1",
  notificationAttemptId: "attempt-current",
  phone: "010-9999-8888",
}), { found: false });

const notificationSource = await readFile(
  new URL("../src/lib/reservation-notifications.ts", import.meta.url),
  "utf8",
);
const solapiSource = await readFile(
  new URL("../src/lib/solapi-sms.ts", import.meta.url),
  "utf8",
);

assert.match(
  notificationSource,
  /notificationStatus: "RECOVERING"[\s\S]*?lookupReservationReminderDelivery/,
  "An interrupted send must enter recovery and query Solapi history before another send.",
);
assert.ok(
  notificationSource.indexOf("lookupReservationReminderDelivery({")
    < notificationSource.indexOf("sendReservationReminder({"),
  "Solapi history lookup must appear before the provider send call.",
);
assert.match(
  notificationSource,
  /notificationAttemptId[\s\S]*?claimNotificationAttempt/,
  "A unique attempt identifier must be persisted as part of claiming a send.",
);
assert.match(
  solapiSource,
  /customFields:[\s\S]*?reservationId:[\s\S]*?notificationAttemptId/,
  "The persisted attempt identifier must be attached to the Solapi message.",
);

console.log("Solapi interrupted-send recovery tests passed.");
