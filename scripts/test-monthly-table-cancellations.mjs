import assert from "node:assert/strict";

import { shouldDisplayReservationInMonthlyTable } from "../src/lib/monthly-table-reservations.ts";

assert.equal(
  shouldDisplayReservationInMonthlyTable({ status: "CANCELLED", isNoShow: false, price: 0 }),
  false,
  "수수료 없는 일반 취소는 월간표에서 완전히 숨겨야 합니다.",
);

assert.equal(
  shouldDisplayReservationInMonthlyTable({ status: "CANCELLED", isNoShow: false, price: 16_000 }),
  true,
  "수수료가 있는 취소는 월간표에 남겨야 합니다.",
);

assert.equal(
  shouldDisplayReservationInMonthlyTable({ status: "CANCELLED", isNoShow: true, price: 0 }),
  true,
  "노쇼는 수수료가 0원이어도 기존 월간표 기록을 유지해야 합니다.",
);

assert.equal(
  shouldDisplayReservationInMonthlyTable({ status: "CONFIRMED", isNoShow: false, price: 0 }),
  true,
  "확정 예약은 금액과 무관하게 표시해야 합니다.",
);

console.log("Monthly table cancellation visibility tests passed.");
