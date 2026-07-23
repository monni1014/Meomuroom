import assert from "node:assert/strict";
import {
  advanceControlVerificationState,
  buildControlSignature,
  normalizeControlText,
  rankControlCandidates,
} from "../rpa/lib/self-healing-controls.mjs";

const definition = {
  key: "test.save",
  primaryLabels: ["저장"],
  aliases: ["변경사항 저장", "적용", "완료"],
  semanticTokens: ["저장"],
  excludeLabels: ["취소"],
  minScore: 85,
  minMargin: 12,
};

function candidate(overrides = {}) {
  return {
    marker: "marker",
    tag: "button",
    role: "button",
    text: "저장",
    ariaLabel: "",
    title: "",
    name: "",
    value: "",
    id: "",
    testId: "",
    visible: true,
    enabled: true,
    area: 4_000,
    yRatio: 0.8,
    ...overrides,
  };
}

assert.equal(normalizeControlText(" 변 경사항-저장! "), "변경사항저장");

const primary = rankControlCandidates([candidate()], definition);
assert.equal(primary.winner?.exactPrimary, true);
assert.equal(primary.winner?.match, "primary-exact");

const alias = rankControlCandidates([candidate({ text: "변경사항 저장" })], definition);
assert.equal(alias.winner?.match, "alias-exact");
assert.equal(alias.winner?.exactPrimary, false);

const outsideBounds = rankControlCandidates([
  candidate({ x: 20, y: 20, width: 100, height: 40 }),
], {
  ...definition,
  bounds: { x: 200, y: 200, width: 500, height: 500 },
});
assert.equal(outsideBounds.winner, null);

const excluded = rankControlCandidates([candidate({ text: "저장 취소" })], definition);
assert.equal(excluded.winner, null);

const ambiguous = rankControlCandidates([
  candidate({ marker: "one", id: "save-one" }),
  candidate({ marker: "two", id: "save-two" }),
], definition);
assert.equal(ambiguous.winner, null);
assert.equal(ambiguous.ambiguous, true);

const verifiedCandidate = {
  ...candidate({ text: "변경사항 저장" }),
  signature: buildControlSignature(candidate({ text: "변경사항 저장" })),
  match: "alias-exact",
};
let state = { key: definition.key };
state = advanceControlVerificationState(state, verifiedCandidate, {
  healthCheck: true,
  now: "2026-07-23T00:00:00.000Z",
});
assert.equal(state.activeSignature, null);
assert.equal(state.pendingPasses, 1);

state = advanceControlVerificationState(state, verifiedCandidate, {
  healthCheck: true,
  now: "2026-07-23T06:00:00.000Z",
});
assert.equal(state.activeSignature, verifiedCandidate.signature);
assert.equal(state.pendingPasses, 0);

const changedCandidate = {
  ...candidate({ text: "완료" }),
  signature: buildControlSignature(candidate({ text: "완료" })),
  match: "alias-exact",
};
state = advanceControlVerificationState(state, changedCandidate, {
  healthCheck: true,
  now: "2026-07-23T12:00:00.000Z",
});
assert.equal(state.activeSignature, verifiedCandidate.signature);
assert.equal(state.pendingPasses, 1);

state = advanceControlVerificationState(state, changedCandidate, {
  healthCheck: true,
  verified: false,
  now: "2026-07-23T12:01:00.000Z",
});
assert.equal(state.pendingPasses, 0);
assert.equal(state.activeSignature, verifiedCandidate.signature);

console.log("Self-healing control tests passed.");
