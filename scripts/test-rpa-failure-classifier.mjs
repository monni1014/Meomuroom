import assert from "node:assert/strict";
import {
  classifyRpaFailure,
  extractRpaEvidencePath,
  summarizeRpaFailure,
} from "../src/lib/rpa-failure-classifier.ts";

const cases = [
  ["SpaceCloud login required. Host center session is missing or expired.", "LOGIN"],
  ["page.goto: net::ERR_PROXY_CONNECTION_FAILED", "NETWORK"],
  ["Could not locate exact next-week arrow button.", "UI_CHANGE"],
  ["locator.waitFor: Timeout 20000ms exceeded", "UI_CHANGE"],
  ["Naver slot RPA is already running.", "BUSY"],
  ["Target 8.4 is not visible. Click next.\nEACCES: permission denied, open 'state.json'", "FAILURE"],
  ["Unexpected child process exit code 1", "FAILURE"],
];

for (const [message, expected] of cases) {
  assert.equal(classifyRpaFailure(message), expected, message);
}

const error = Object.assign(new Error("Command failed"), {
  stderr: [
    "Naver slot RPA failed: Could not find schedule grid for booking 1234567890 and 010-1234-5678",
    "RPA_EVIDENCE_PATH=/srv/memoroom/app/rpa/screenshots/naver-slots-error.png",
  ].join("\n"),
});

assert.equal(
  extractRpaEvidencePath(error),
  "/srv/memoroom/app/rpa/screenshots/naver-slots-error.png",
);
assert.equal(summarizeRpaFailure(error).includes("010-1234-5678"), false);
assert.equal(summarizeRpaFailure(error).includes("1234567890"), false);

assert.match(
  summarizeRpaFailure("Target 8.4 is not visible.\nEACCES: permission denied, open 'state.json'"),
  /EACCES|permission denied/i,
);

console.log("RPA failure classifier tests passed.");
