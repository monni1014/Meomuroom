import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  dawnBookingAutoSendStartsAt,
  isDawnBookingStart,
} from "../src/lib/dawn-booking-policy.ts";

const kst = (clock) => new Date(`2026-07-24T${clock}:00+09:00`);

assert.equal(isDawnBookingStart(kst("00:59")), false);
assert.equal(isDawnBookingStart(kst("01:00")), true);
assert.equal(isDawnBookingStart(kst("06:59")), true);
assert.equal(isDawnBookingStart(kst("07:00")), true);
assert.equal(isDawnBookingStart(kst("07:01")), false);
assert.equal(dawnBookingAutoSendStartsAt(""), null);
assert.equal(
  dawnBookingAutoSendStartsAt("2026-07-24T18:00:00+09:00")?.toISOString(),
  "2026-07-24T09:00:00.000Z",
);

const notificationSource = await readFile(
  new URL("../src/lib/dawn-booking-notifications.ts", import.meta.url),
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

assert.match(notificationSource, /createdAt: \{ gte: startsAt \}/);
assert.match(notificationSource, /startTime: \{ gte: now \}/);
assert.match(notificationSource, /isDawnBookingStart\(reservation\.startTime\)/);
assert.match(notificationSource, /situation:dawn-booking:/);
assert.match(notificationSource, /status: "SENDING"[\s\S]*?sendReservationSituationMessage/);
assert.match(notificationSource, /lookupReservationReminderDelivery[\s\S]*?중복 방지/);
assert.match(webhookSource, /isStandardReservationReminder[\s\S]*?if \(message\.reservationId && isStandardReservationReminder\)/);
assert.match(messagesPageSource, /reservation-reminder:[\s\S]*?reservation-test:/);

console.log("Dawn booking notification tests passed.");

