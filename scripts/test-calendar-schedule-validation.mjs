import { validateCleaningScheduleInput } from "../src/lib/cleaning-schedule.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const cleaning = validateCleaningScheduleInput({
  scheduleType: "CLEANING",
  roomNames: ["머무룸1", "머무룸3"],
  cleanerName: "청소 담당자",
  contactPhone: "010-9876-5432",
  startTime: "2026-07-28T00:00:00.000Z",
  endTime: "2026-07-28T01:00:00.000Z",
  cost: 20000,
  isPaid: true,
  memo: "테스트",
});
assert(cleaning.ok, "cleaning schedule should be valid");
if (cleaning.ok) {
  assert(cleaning.data.scheduleType === "CLEANING", "cleaning type should be preserved");
  assert(cleaning.data.contactPhone === "010-9876-5432", "cleaning phone should be preserved");
  assert(cleaning.data.source === null, "cleaning should not store a source");
  assert(cleaning.data.cost === 20000, "cleaning cost should be preserved");
  assert(cleaning.data.isPaid === true, "cleaning payment status should be preserved");
}

const siteVisit = validateCleaningScheduleInput({
  scheduleType: "SITE_VISIT",
  roomNames: ["머무룸2"],
  cleanerName: "답사 방문자",
  contactPhone: "010-1234-5678",
  source: "spacecloud",
  startTime: "2026-07-28T02:00:00.000Z",
  endTime: "2026-07-28T03:00:00.000Z",
  cost: 99999,
  isPaid: true,
  memo: "스클 문의",
});
assert(siteVisit.ok, "site visit schedule should be valid");
if (siteVisit.ok) {
  assert(siteVisit.data.scheduleType === "SITE_VISIT", "site visit type should be preserved");
  assert(siteVisit.data.source === "spacecloud", "site visit source should be preserved");
  assert(siteVisit.data.contactPhone === "010-1234-5678", "site visit phone should be preserved");
  assert(siteVisit.data.cost === 0, "site visit should never record cleaning cost");
  assert(siteVisit.data.isPaid === false, "site visit should never record cleaning payment status");
}

const unpaidCleaning = validateCleaningScheduleInput({
  scheduleType: "CLEANING",
  roomNames: ["머무룸1"],
  cleanerName: "미입금 청소 담당자",
  startTime: "2026-07-28T04:00:00.000Z",
  endTime: "2026-07-28T05:00:00.000Z",
  cost: 10000,
});
assert(unpaidCleaning.ok, "cleaning schedule without payment flag should be valid");
if (unpaidCleaning.ok) {
  assert(unpaidCleaning.data.isPaid === false, "missing cleaning payment status should default to unpaid");
}

const missingSource = validateCleaningScheduleInput({
  scheduleType: "SITE_VISIT",
  roomNames: ["머무룸1"],
  cleanerName: "답사 방문자",
  contactPhone: "010-1234-5678",
  startTime: "2026-07-28T02:00:00.000Z",
  endTime: "2026-07-28T03:00:00.000Z",
});
assert(!missingSource.ok, "site visit source must be required");

const missingPhone = validateCleaningScheduleInput({
  scheduleType: "SITE_VISIT",
  roomNames: ["머무룸1"],
  cleanerName: "연락처 없는 답사 방문자",
  contactPhone: "",
  source: "naver",
  startTime: "2026-07-28T02:00:00.000Z",
  endTime: "2026-07-28T03:00:00.000Z",
});
assert(missingPhone.ok, "site visit phone should be optional");
if (missingPhone.ok) {
  assert(missingPhone.data.contactPhone === null, "missing site visit phone should be stored as null");
}

const invalidPhone = validateCleaningScheduleInput({
  scheduleType: "SITE_VISIT",
  roomNames: ["머무룸1"],
  cleanerName: "답사 방문자",
  contactPhone: "1234",
  source: "naver",
  startTime: "2026-07-28T02:00:00.000Z",
  endTime: "2026-07-28T03:00:00.000Z",
});
assert(!invalidPhone.ok, "site visit phone must be validated");

const invalidCleaningPhone = validateCleaningScheduleInput({
  scheduleType: "CLEANING",
  roomNames: ["머무룸2"],
  cleanerName: "청소 담당자",
  contactPhone: "1234",
  startTime: "2026-07-28T04:00:00.000Z",
  endTime: "2026-07-28T05:00:00.000Z",
  cost: 10000,
});
assert(!invalidCleaningPhone.ok, "cleaning phone must be validated when provided");

console.log("Calendar schedule validation tests passed.");
