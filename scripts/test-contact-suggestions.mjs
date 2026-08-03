import assert from "node:assert/strict";
import {
  buildContactSuggestions,
  findContactSuggestions,
} from "../src/lib/contact-suggestions.ts";

const contacts = buildContactSuggestions([
  {
    name: "이동주",
    phone: "01039160506",
    usedAt: "2026-07-01T00:00:00.000Z",
    context: "머무룸1 예약",
  },
  {
    name: "이동주",
    phone: "010-3916-0506",
    usedAt: "2026-07-27T00:00:00.000Z",
    context: "청소",
  },
  {
    name: "이동주",
    phone: "010-9999-8888",
    usedAt: "2026-07-20T00:00:00.000Z",
    context: "사전답사",
  },
  {
    name: "이동준",
    phone: "010-1111-2222",
    usedAt: "2026-07-25T00:00:00.000Z",
    context: "머무룸2 예약",
  },
  { name: "이*주", phone: "010-2222-3333", usedAt: new Date(), context: "예약" },
  { name: "미지정", phone: "010-3333-4444", usedAt: new Date(), context: "예약" },
  { name: "번호없음", phone: null, usedAt: new Date(), context: "예약" },
]);

assert.equal(contacts.length, 4, "마스킹·미지정 기록은 제외하고 전화번호 없는 이름 기록은 추천에 남겨야 합니다.");

const exactMatches = findContactSuggestions(contacts, "이동주");
assert.equal(exactMatches.length, 2, "같은 이름에 다른 번호가 있으면 두 번호 모두 제안해야 합니다.");
assert.equal(exactMatches[0].phone, "010-3916-0506", "최근 사용한 번호가 먼저 나와야 합니다.");
assert.deepEqual(exactMatches[0].contexts.sort(), ["머무룸1 예약", "청소"].sort());

const partialMatches = findContactSuggestions(contacts, "이동");
assert.equal(partialMatches.length, 3, "이름 일부만 입력해도 관련 연락처를 제안해야 합니다.");

const nameOnlyMatches = findContactSuggestions(contacts, "번호없");
assert.equal(nameOnlyMatches.length, 1, "전화번호가 없어도 이전에 입력한 이름은 제안해야 합니다.");
assert.equal(nameOnlyMatches[0].name, "번호없음");
assert.equal(nameOnlyMatches[0].phone, "");

assert.deepEqual(findContactSuggestions(contacts, ""), []);

console.log("Contact suggestion tests passed.");
