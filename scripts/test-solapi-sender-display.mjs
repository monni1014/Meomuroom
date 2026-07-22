import assert from "node:assert/strict";
import {
  solapiSenderDisplayName,
  solapiSenderDisplayOrder,
} from "../src/lib/solapi-sender-display.ts";

assert.equal(solapiSenderDisplayName("01094431849"), "짹짹공주");
assert.equal(solapiSenderDisplayName("01071835720"), "뚜이왕자");
assert.equal(solapiSenderDisplayName("01000000000"), "등록 발신번호");

const ordered = ["01071835720", "01000000000", "01094431849"]
  .sort((left, right) => solapiSenderDisplayOrder(left) - solapiSenderDisplayOrder(right));
assert.deepEqual(ordered, ["01094431849", "01071835720", "01000000000"]);

console.log("Solapi sender display tests passed.");
