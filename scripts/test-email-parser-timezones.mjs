import {
  parseNaverEmail,
  parseSpaceCloudEmail,
} from "../src/lib/email-parser.ts";

function assertIso(label, actual, expected) {
  const value = actual?.toISOString();
  if (value !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${value || "null"}`);
  }
}

function naverTimes(label, timeText, expectedStart, expectedEnd) {
  const parsed = parseNaverEmail(
    "네이버 예약 취소",
    `머무룸 예약하기 1 결제금액 머무룸 예약하기 1(1) 10,000원 예약일시 2026.08.28(금) ${timeText} 예약자명 양*우님 환불수수료 0원`,
    `test-${label}`,
  );
  if (!parsed) throw new Error(`${label}: Naver mail was not parsed`);
  assertIso(`${label} start`, parsed.startTime, expectedStart);
  assertIso(`${label} end`, parsed.endTime, expectedEnd);
}

naverTimes(
  "naver-morning",
  "오전 8:00~오전 10:00",
  "2026-08-27T23:00:00.000Z",
  "2026-08-28T01:00:00.000Z",
);
naverTimes(
  "naver-afternoon",
  "오후 5:00~오후 7:00",
  "2026-08-28T08:00:00.000Z",
  "2026-08-28T10:00:00.000Z",
);
naverTimes(
  "naver-midnight-start",
  "오전 12:00~오전 1:00",
  "2026-08-27T15:00:00.000Z",
  "2026-08-27T16:00:00.000Z",
);
naverTimes(
  "naver-cross-midnight",
  "오후 11:00~오전 1:00",
  "2026-08-28T14:00:00.000Z",
  "2026-08-28T16:00:00.000Z",
);
naverTimes(
  "naver-2359-as-2400",
  "오후 8:00~오후 11:59",
  "2026-08-28T11:00:00.000Z",
  "2026-08-28T15:00:00.000Z",
);

const spaceCloudMorning = parseSpaceCloudEmail(
  "스페이스클라우드 예약",
  "머무룸 예약하기 1 예약내용 2026/08/28 8시 - 10시 예약인원 1명 예약자명 테스트 결제금액 ₩10,000",
  "test-spacecloud-morning",
);
if (!spaceCloudMorning) throw new Error("spacecloud-morning: mail was not parsed");
assertIso("spacecloud-morning start", spaceCloudMorning.startTime, "2026-08-27T23:00:00.000Z");
assertIso("spacecloud-morning end", spaceCloudMorning.endTime, "2026-08-28T01:00:00.000Z");

const spaceCloudMidnight = parseSpaceCloudEmail(
  "스페이스클라우드 예약",
  "머무룸 예약하기 1 예약내용 2026/08/28 23시 - 24시 예약인원 1명 예약자명 테스트 결제금액 ₩10,000",
  "test-spacecloud-midnight",
);
if (!spaceCloudMidnight) throw new Error("spacecloud-midnight: mail was not parsed");
assertIso("spacecloud-midnight start", spaceCloudMidnight.startTime, "2026-08-28T14:00:00.000Z");
assertIso("spacecloud-midnight end", spaceCloudMidnight.endTime, "2026-08-28T15:00:00.000Z");

console.log("Email parser KST timezone checks passed (7 cases).");
