import assert from "node:assert/strict";
import { plannedRestartBusyReasons } from "../src/lib/planned-restart-policy.ts";

const idle = {
  queue: {
    queued: 0,
    active: 0,
    activeOrCoolingDown: 0,
    running: false,
    slotRecheckRunning: false,
    naverStatusReconcileRunning: false,
  },
  competitorScanRunning: false,
  sendingCustomerNotifications: 0,
};
assert.deepEqual(plannedRestartBusyReasons(idle), []);
assert.deepEqual(plannedRestartBusyReasons({
  ...idle,
  queue: { ...idle.queue, running: true, queued: 2, active: 1 },
  competitorScanRunning: true,
}), [
  "reservation-rpa-running",
  "reservation-rpa-queued",
  "reservation-rpa-active",
  "competitor-scan-running",
]);
assert.deepEqual(plannedRestartBusyReasons({
  ...idle,
  sendingCustomerNotifications: 1,
}), ["customer-sms-sending"]);

console.log("Planned restart policy tests passed.");
