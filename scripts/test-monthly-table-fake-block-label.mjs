import assert from "node:assert/strict";
import {
  buildMonthlyTablePaintChanges,
  MONTHLY_FAKE_BLOCK_LABEL,
} from "../src/lib/monthly-table-fake-block.ts";

const prefix = "머무룸1|2026-08-11|";
const cell = (value = "", color = null) => ({ value, color });
const apply = (cells, hour, selection) => ({
  ...cells,
  ...buildMonthlyTablePaintChanges({
    cells,
    sectionId: "머무룸1",
    dateKey: "2026-08-11",
    cellKey: `hour-${hour}`,
    selection,
  }),
});

let cells = apply({}, 10, "fake-block");
assert.deepEqual(cells[`${prefix}hour-10`], cell(MONTHLY_FAKE_BLOCK_LABEL, "fake-block"));

cells = apply(cells, 11, "fake-block");
assert.deepEqual(cells[`${prefix}hour-10`], cell(MONTHLY_FAKE_BLOCK_LABEL, "fake-block"));
assert.deepEqual(cells[`${prefix}hour-11`], cell("", "fake-block"));

cells = apply(cells, 9, "fake-block");
assert.deepEqual(cells[`${prefix}hour-9`], cell(MONTHLY_FAKE_BLOCK_LABEL, "fake-block"));
assert.deepEqual(cells[`${prefix}hour-10`], cell("", "fake-block"));

cells = apply(cells, 9, "clear");
assert.deepEqual(cells[`${prefix}hour-9`], cell("", null));
assert.deepEqual(cells[`${prefix}hour-10`], cell(MONTHLY_FAKE_BLOCK_LABEL, "fake-block"));

const memoCells = {
  [`${prefix}hour-14`]: cell("직접 메모", null),
};
const paintedMemoCells = apply(memoCells, 14, "fake-block");
assert.deepEqual(paintedMemoCells[`${prefix}hour-14`], cell("직접 메모", "fake-block"));

console.log("monthly table fake-block label tests passed");
