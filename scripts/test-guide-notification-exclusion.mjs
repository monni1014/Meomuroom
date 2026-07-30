import assert from "node:assert/strict";
import {
  MANUAL_GUIDE_EXCLUSION_REASON,
  canExcludeGuideNotification,
  isManualGuideNotificationExclusion,
} from "../src/lib/guide-notification-exclusion.ts";

assert.equal(canExcludeGuideNotification({
  notificationStatus: "PENDING",
  notified: false,
  reservationStatus: "CONFIRMED",
  hasOutboundReminder: false,
}), true);

assert.equal(canExcludeGuideNotification({
  notificationStatus: "SENDING",
  notified: false,
  reservationStatus: "CONFIRMED",
  hasOutboundReminder: false,
}), false);

assert.equal(canExcludeGuideNotification({
  notificationStatus: "PENDING",
  notified: true,
  reservationStatus: "CONFIRMED",
  hasOutboundReminder: true,
}), false);

assert.equal(isManualGuideNotificationExclusion({
  notificationStatus: "SKIPPED",
  notificationError: MANUAL_GUIDE_EXCLUSION_REASON,
}), true);

assert.equal(isManualGuideNotificationExclusion({
  notificationStatus: "SKIPPED",
  notificationError: "같은 고객의 연속 예약이라 자동 제외",
}), false);

console.log("Guide notification exclusion tests passed.");
