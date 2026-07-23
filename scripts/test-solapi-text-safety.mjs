import assert from "node:assert/strict";
import { findSolapiTextEncodingIssue } from "../src/lib/solapi-text-safety.ts";

assert.equal(
  findSolapiTextEncodingIssue("[머무룸] 갤럭시 Tailscale이 15분째 꺼져 있습니다."),
  null,
);
assert.equal(findSolapiTextEncodingIssue("예약 시간이 맞으실까요?"), null);
assert.match(findSolapiTextEncodingIssue("[??? ???] ??? Tailscale?") || "", /연속 물음표/);
assert.match(findSolapiTextEncodingIssue("머무룸 � 안내" ) || "", /대체문자/);

console.log("Solapi text encoding safety tests passed.");

