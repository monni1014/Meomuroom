import assert from "node:assert/strict";
import { shouldSendAdminAlertPush } from "../src/lib/admin-alert-push-policy.ts";

for (const type of ["RPA_UI_CHANGE", "RPA_LOGIN_SESSION", "RPA_NETWORK", "RPA_FAILURE"]) {
  assert.equal(shouldSendAdminAlertPush(type, "WARNING"), true, `${type} must send an app push`);
}

assert.equal(shouldSendAdminAlertPush("NOTIFICATION_DELIVERY", "CRITICAL"), true);
assert.equal(shouldSendAdminAlertPush("COMPETITOR_SCAN", "CRITICAL"), true);
assert.equal(shouldSendAdminAlertPush("GOOGLE_PEOPLE_SYNC_FAILED", "WARNING"), false);
assert.equal(shouldSendAdminAlertPush("INFORMATION", "INFO"), false);

console.log("Admin alert app-push policy tests passed.");
