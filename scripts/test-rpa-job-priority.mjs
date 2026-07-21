import assert from "node:assert/strict";
import {
  CANCELLATION_MAX_QUEUE_WAIT_MS,
  MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION,
  cancellationQueueWaitMs,
  selectNextRpaJobIndex,
} from "../src/lib/rpa-job-priority.ts";

const NOW = 1_000_000;

function job(source, isCancelled, enqueuedAt) {
  return {
    source,
    parsedReservation: { isCancelled },
    enqueuedAt,
  };
}

const recentCancellation = [
  job("naver", false, NOW - 30_000),
  job("naver", true, NOW - CANCELLATION_MAX_QUEUE_WAIT_MS + 1),
];
assert.equal(
  selectNextRpaJobIndex(recentCancellation, "naver", NOW),
  0,
  "A new confirmation stays ahead while the cancellation is within the wait limit.",
);
assert.equal(
  selectNextRpaJobIndex(
    recentCancellation,
    "naver",
    NOW,
    CANCELLATION_MAX_QUEUE_WAIT_MS,
    MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION,
  ),
  1,
  "A cancellation runs after two confirmations even before the time limit.",
);

const overdueCancellation = [
  job("naver", false, NOW - 20_000),
  job("naver", false, NOW - 10_000),
  job("naver", true, NOW - CANCELLATION_MAX_QUEUE_WAIT_MS),
];
assert.equal(
  selectNextRpaJobIndex(overdueCancellation, "naver", NOW),
  2,
  "An overdue cancellation jumps ahead of later confirmation work.",
);

const independentSources = [
  job("spacecloud", true, NOW - CANCELLATION_MAX_QUEUE_WAIT_MS),
  job("naver", false, NOW - 10_000),
  job("naver", true, NOW - 20_000),
];
assert.equal(
  selectNextRpaJobIndex(independentSources, "naver", NOW),
  1,
  "An overdue cancellation on another source does not reorder this source.",
);
assert.equal(
  cancellationQueueWaitMs(job("naver", true, NOW - 12_345), NOW),
  12_345,
);
assert.equal(cancellationQueueWaitMs(job("naver", false, NOW - 12_345), NOW), 0);
assert.equal(selectNextRpaJobIndex([], "naver", NOW), -1);

console.log("RPA job priority tests passed.");
