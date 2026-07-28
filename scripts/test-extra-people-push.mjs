import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildExtraPeoplePush,
  resolveAdditionalPeople,
} from "../src/lib/reservation-extra-people-push.ts";
import { selectPushSubscriptions } from "../src/lib/push-subscription-selection.ts";

assert.equal(resolveAdditionalPeople({ headCount: 18, reservedHeadCount: 17 }), 1);
assert.equal(resolveAdditionalPeople({ headCount: 16, reservedHeadCount: 17 }), 0);

const push = buildExtraPeoplePush({
  id: "reservation-1",
  roomName: "머무룸1",
  customerName: "추가금 고객",
  startTime: new Date("2026-07-28T06:00:00.000Z"),
  endTime: new Date("2026-07-28T09:00:00.000Z"),
  previousHeadCount: 17,
  headCount: 18,
  additionalPeople: 1,
  unpaidExtraAmount: 12_000,
});
assert.deepEqual(push, {
  title: "추가 인원 발생 · 머무룸1",
  body: "추가금 고객\n7월 28일 15:00~18:00\n실제 인원 17명 → 18명 (추가 1명)\n추가금 12,000원 결제 필요",
  url: "/calendar?date=2026-07-28",
  tag: "reservation-extra-people-reservation-1-18",
});

const subscriptions = ["origin", "wife", "desktop"].map((name) => ({
  endpoint: `https://push.example/${name}`,
}));
assert.deepEqual(
  selectPushSubscriptions(subscriptions, {
    excludeEndpoints: ["https://push.example/origin"],
  }).map(({ endpoint }) => endpoint),
  ["https://push.example/wife", "https://push.example/desktop"],
);

const routeSource = await readFile(
  new URL("../src/app/api/reservations/[id]/route.ts", import.meta.url),
  "utf8",
);
assert.match(routeSource, /nextAdditionalPeople > previousAdditionalPeople/);
assert.match(routeSource, /excludeEndpoints: excludedEndpoint \? \[excludedEndpoint\] : \[\]/);

console.log("Extra people push tests passed.");
