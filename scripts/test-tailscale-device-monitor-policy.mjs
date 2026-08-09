import assert from "node:assert/strict";
import { evaluateTailscaleDeviceObservation } from "../src/lib/tailscale-device-monitor-policy.ts";
import fs from "node:fs";

const start = new Date("2026-07-23T10:00:00.000Z");
const firstOffline = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: start,
  offlineThresholdMinutes: 15,
  observation: { registered: true, online: false },
});
assert.equal(firstOffline.shouldAlert, false);
assert.equal(firstOffline.shouldRemind, false);
assert.equal(firstOffline.state.consecutiveOffline, 1);

const shortOffline = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 10 * 60_000),
  offlineThresholdMinutes: 15,
  previous: firstOffline.state,
  observation: { registered: true, online: false },
});
assert.equal(shortOffline.shouldAlert, false);

const iphoneAlmostThreeHoursOffline = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 179 * 60_000),
  offlineThresholdMinutes: 180,
  previous: firstOffline.state,
  observation: { registered: true, online: false },
});
assert.equal(iphoneAlmostThreeHoursOffline.shouldAlert, false);

const iphoneThreeHoursOffline = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 180 * 60_000),
  offlineThresholdMinutes: 180,
  previous: iphoneAlmostThreeHoursOffline.state,
  observation: { registered: true, online: false },
});
assert.equal(iphoneThreeHoursOffline.shouldAlert, true);

const longOffline = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 15 * 60_000),
  offlineThresholdMinutes: 15,
  previous: shortOffline.state,
  observation: { registered: true, online: false },
});
assert.equal(longOffline.shouldAlert, true);
assert.match(longOffline.state.alertDedupeKey || "", /^tailscale-device-offline:wife-iphone:/);

const handledWithoutSms = evaluateTailscaleDeviceObservation({
  deviceId: "owner-galaxy",
  now: new Date(start.getTime() + 16 * 60_000),
  offlineThresholdMinutes: 15,
  previous: { ...longOffline.state, alertHandledAt: new Date(start.getTime() + 15 * 60_000).toISOString() },
  observation: { registered: true, online: false },
});
assert.equal(handledWithoutSms.shouldAlert, false);
assert.equal(handledWithoutSms.shouldRemind, false);

const firstSmsAt = new Date(start.getTime() + 15 * 60_000);
const sentState = { ...longOffline.state, smsSentAt: firstSmsAt.toISOString() };
const noDuplicate = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 20 * 60_000),
  offlineThresholdMinutes: 15,
  previous: sentState,
  observation: { registered: true, online: false },
});
assert.equal(noDuplicate.shouldAlert, false);
assert.equal(noDuplicate.shouldRemind, false);

const beforeReminder = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(firstSmsAt.getTime() + 59 * 60_000),
  offlineThresholdMinutes: 15,
  reminderDelayMinutes: 60,
  previous: noDuplicate.state,
  observation: { registered: true, online: false },
});
assert.equal(beforeReminder.shouldRemind, false);

const reminderDue = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(firstSmsAt.getTime() + 60 * 60_000),
  offlineThresholdMinutes: 15,
  reminderDelayMinutes: 60,
  previous: beforeReminder.state,
  observation: { registered: true, online: false },
});
assert.equal(reminderDue.shouldRemind, true);

const reminderSentState = {
  ...reminderDue.state,
  reminderSmsSentAt: new Date(firstSmsAt.getTime() + 60 * 60_000).toISOString(),
};
const noThirdSms = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(firstSmsAt.getTime() + 3 * 60 * 60_000),
  offlineThresholdMinutes: 15,
  reminderDelayMinutes: 60,
  previous: reminderSentState,
  observation: { registered: true, online: false },
});
assert.equal(noThirdSms.shouldAlert, false);
assert.equal(noThirdSms.shouldRemind, false);

const recovered = evaluateTailscaleDeviceObservation({
  deviceId: "wife-iphone",
  now: new Date(start.getTime() + 25 * 60_000),
  offlineThresholdMinutes: 15,
  previous: noThirdSms.state,
  observation: { registered: true, online: true, dnsName: "iphone-14.tail11465e.ts.net." },
});
assert.equal(recovered.recoveredAlertKey, noThirdSms.state.alertDedupeKey);
assert.equal(recovered.state.offlineSince, null);
assert.equal(recovered.state.smsSentAt, null);
assert.equal(recovered.state.reminderSmsSentAt, null);

const pendingDesktop = evaluateTailscaleDeviceObservation({
  deviceId: "owner-desktop",
  now: start,
  offlineThresholdMinutes: 15,
  observation: { registered: false, online: false },
});
assert.equal(pendingDesktop.shouldAlert, false);
assert.equal(pendingDesktop.state.registered, false);

const solapiSmsSource = fs.readFileSync(new URL("../src/lib/solapi-sms.ts", import.meta.url), "utf8");
assert.match(solapiSmsSource, /SOLAPI_SMS_MAX_BYTES = 90/);
assert.match(solapiSmsSource, /type: "SMS"/);
assert.match(solapiSmsSource, /Operational alert exceeds the/);

console.log("Tailscale device monitor policy tests passed.");
