import assert from "node:assert/strict";
import {
  PROXY_CONNECTION_CONFIRM_DELAYS_MS,
  PROXY_OUTAGE_ALERT_REPEAT_MS,
  shouldConfirmProxyConnectionFailure,
} from "../src/lib/proxy-health-alert-policy.ts";

assert.deepEqual(PROXY_CONNECTION_CONFIRM_DELAYS_MS, [3_000, 7_000]);
assert.equal(PROXY_OUTAGE_ALERT_REPEAT_MS, 15 * 60 * 1000);

assert.equal(shouldConfirmProxyConnectionFailure({
  endpointConfigured: true,
  connectionOk: false,
  severity: "ERROR",
}), true, "configured connection failures must be confirmed before alerting");

assert.equal(shouldConfirmProxyConnectionFailure({
  endpointConfigured: true,
  connectionOk: true,
  severity: "ERROR",
}), false, "country or fixed-IP mismatches must alert without connection retries");

assert.equal(shouldConfirmProxyConnectionFailure({
  endpointConfigured: false,
  connectionOk: false,
  severity: "NOT_CONFIGURED",
}), false, "missing configuration is not a transient connection failure");

assert.equal(shouldConfirmProxyConnectionFailure({
  endpointConfigured: true,
  connectionOk: true,
  severity: "WARNING",
}), false, "management warnings are not connection failures");

console.log("Proxy health alert policy tests passed");
