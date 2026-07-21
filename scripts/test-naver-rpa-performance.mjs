import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStepTimer } from "../rpa/lib/step-timer.mjs";

const detailSource = await readFile(new URL("../rpa/naver-read-booking-detail.mjs", import.meta.url), "utf8");
const slotSource = await readFile(new URL("../rpa/naver-toggle-slots.mjs", import.meta.url), "utf8");

assert.match(detailSource, /NAVER_DETAIL_READY_TIMEOUT_MS[\s\S]*28000/);
assert.doesNotMatch(detailSource, /naver-booking-detail-read/);
assert.match(detailSource, /naver-booking-detail-error/);

for (const normalScreenshot of [
  "naver-slots-01-product-url",
  "naver-slots-03-schedule",
  "naver-slots-04-target-week",
  "naver-slots-05-slot-panel",
  "naver-slots-06-after-toggle",
  "naver-slots-07-verify-panel",
]) {
  assert.doesNotMatch(slotSource, new RegExp(normalScreenshot));
}
assert.match(slotSource, /verifySavedSlotState/);
assert.match(slotSource, /assertPanelHoursReadOnly/);
assert.match(slotSource, /--verify-only/);
assert.match(slotSource, /verify-only-completed/);
assert.match(slotSource, /naver-slots-error/);

const lines = [];
const originalLog = console.log;
let clock = 100;
try {
  console.log = (line) => lines.push(String(line));
  const timer = createStepTimer("test", { bookingId: "123" }, () => clock);
  clock = 145;
  timer.mark("loaded");
  clock = 205;
  timer.mark("verified", { status: "ok" });
} finally {
  console.log = originalLog;
}

assert.equal(lines.length, 2);
assert.match(lines[0], /^\[RPA_TIMING\] /);
assert.match(lines[0], /stepMs=45/);
assert.match(lines[1], /stepMs=60/);
assert.match(lines[1], /totalMs=105/);
assert.match(lines[1], /status=ok/);

console.log("Naver RPA performance tests passed.");
