import assert from "node:assert/strict";
import {
  resolveRpaProxyCircuitMode,
  rpaProxyIsRequired,
} from "../src/lib/rpa-proxy-circuit-policy.ts";

const proxyRequiredEnv = {
  RPA_USE_PROXY: "true",
  RPA_PROXY_DIRECT_FALLBACK: "false",
};

function status(overrides = {}) {
  return {
    provider: "Proxy-Seller",
    configured: true,
    apiConfigured: true,
    endpointConfigured: true,
    apiOk: true,
    connectionOk: true,
    severity: "OK",
    summary: "정상",
    orderStatus: "ACTIVE",
    country: "KR",
    expiresOn: "2026-10-23",
    daysRemaining: 87,
    autoRenew: true,
    autoRenewPeriod: "3 months",
    expectedIp: "158.247.x.x",
    detectedIp: "158.247.x.x",
    ipMatches: true,
    detectedCountry: "KR",
    detectedOrganization: "ISP",
    checkedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

assert.equal(rpaProxyIsRequired(proxyRequiredEnv), true);
assert.equal(rpaProxyIsRequired({ RPA_USE_PROXY: "false" }), false);
assert.equal(resolveRpaProxyCircuitMode(status(), proxyRequiredEnv), "READY");
assert.equal(
  resolveRpaProxyCircuitMode(status({ apiOk: false, severity: "WARNING" }), proxyRequiredEnv),
  "READY",
  "a management API warning must not stop RPA when the proxy connection is verified",
);
assert.equal(
  resolveRpaProxyCircuitMode(status({ connectionOk: false, severity: "ERROR" }), proxyRequiredEnv),
  "PAUSED",
);
assert.equal(
  resolveRpaProxyCircuitMode(status({ connectionOk: true, severity: "ERROR", ipMatches: false }), proxyRequiredEnv),
  "PAUSED",
  "a fixed-IP or country mismatch must pause RPA even if TCP access works",
);
assert.equal(
  resolveRpaProxyCircuitMode(status({ endpointConfigured: false, severity: "NOT_CONFIGURED" }), proxyRequiredEnv),
  "PAUSED",
);
assert.equal(
  resolveRpaProxyCircuitMode(status({ connectionOk: false, severity: "ERROR" }), { RPA_USE_PROXY: "false" }),
  "READY",
  "the circuit must stay out of the way when proxy enforcement is disabled",
);

console.log("RPA proxy circuit policy tests passed");

