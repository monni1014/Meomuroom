import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const slotSource = await readFile(new URL("../rpa/spacecloud-external-reservation.mjs", import.meta.url), "utf8");
const syncSource = await readFile(new URL("../src/lib/naver-rpa-sync.ts", import.meta.url), "utf8");

const dateFunctionStart = slotSource.indexOf("async function typeModalDate");
const dateFunctionEnd = slotSource.indexOf("async function clickModalTextButton", dateFunctionStart);
assert.ok(dateFunctionStart >= 0 && dateFunctionEnd > dateFunctionStart);
const dateFunction = slotSource.slice(dateFunctionStart, dateFunctionEnd);
assert.match(dateFunction, /openModalDatePicker/);
assert.match(dateFunction, /clickModalDatePickerDay/);
assert.match(dateFunction, /setModalDateDirectly/);
assert.match(slotSource, /SpaceCloud modal date picker moved to/);
assert.match(slotSource, /querySelectorAll\("\.calendar_ly_repeat \.calendar_tit"\)/);
assert.match(slotSource, /rect\.x \+ 16 : rect\.x \+ rect\.width - 16/);
assert.doesNotMatch(
  slotSource.slice(
    slotSource.indexOf("async function clickModalDatePickerMonthArrow"),
    slotSource.indexOf("async function navigateModalDatePickerToMonth"),
  ),
  /humanDelay/,
);
assert.match(slotSource, /\["SDATE", "EDATE", "SHOUR", "EHOUR"\]/);

assert.match(slotSource, /createStepTimer\("spacecloud-external"/);
assert.match(slotSource, /external-reservation-saved/);
assert.match(slotSource, /external-reservation-verified/);
assert.match(slotSource, /external-reservation-deleted/);
assert.match(slotSource, /external-reservation-delete-verified/);
assert.match(syncSource, /FAST_SPACECLOUD_SLOT_RPA_ENV[\s\S]*RPA_DELAY_MULTIPLIER: "0\.42"/);
assert.match(syncSource, /FAST_SPACECLOUD_SLOT_RPA_ENV[\s\S]*RPA_MIN_RANDOM_DELAY_FLOOR_MS: "250"/);
assert.match(syncSource, /writeRpaTimingLogs\(result\.stdout\)/);

console.log("SpaceCloud RPA performance tests passed.");
