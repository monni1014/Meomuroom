import assert from "node:assert/strict";
import {
  extractNaverBookingListRow,
  isValidNaverBookingNumber,
  isValidNaverCustomerName,
  isValidNaverDateTimeParts,
  isValidNaverPaymentStatus,
  isValidNaverPhone,
  isValidNaverPrice,
  isValidNaverProductName,
  isValidNaverQuantity,
  parseNaverBookingListDateTime,
} from "../rpa/lib/naver-booking-row.mjs";

const text = `
예약 상세정보
닫기
확정
홍길동
010-1234-5678 1299214385
26. 7. 23.(목) 오후 12:00~2:00
머무룸 예약하기 3
4
-
결제완료
14,400원
확정
김대리
대리예약
방문자: 이방문
010-2222-3333
010-1111-2222 1299214000
26. 7. 23.(목) 오전 11:00~4:00
머무룸 예약하기 2
8
-
결제완료
40,000원
`;

const direct = extractNaverBookingListRow(text, "1299214385");
assert.equal(direct?.bookingStatus, "확정");
assert.equal(direct?.customerName, "홍길동");
assert.equal(direct?.phone, "010-1234-5678");
assert.equal(direct?.productName, "머무룸 예약하기 3");
assert.equal(direct?.useDateText, "2026. 7. 23.");
assert.equal(direct?.useTimeText, "오후 12:00 ~ 오후 2:00");
assert.equal(direct?.quantity, "4");
assert.equal(direct?.paymentStatus, "결제완료");
assert.equal(direct?.priceText, "14,400원");

const proxy = extractNaverBookingListRow(text, "1299214000");
assert.equal(proxy?.customerName, "김대리");
assert.equal(proxy?.useTimeText, "오전 11:00 ~ 오후 4:00");
assert.equal(proxy?.productName, "머무룸 예약하기 2");

assert.deepEqual(parseNaverBookingListDateTime("26. 7. 23.(목) 오전 9:00~10:00"), {
  dateText: "2026. 7. 23.",
  timeText: "오전 9:00 ~ 오전 10:00",
  combined: "2026. 7. 23. 오전 9:00 ~ 오전 10:00",
});
assert.equal(parseNaverBookingListDateTime("상품"), null);
assert.equal(extractNaverBookingListRow("상품\n수량", "1299214385"), null);
assert.equal(isValidNaverBookingNumber("예약번호", "1299214385"), false);
assert.equal(isValidNaverBookingNumber("1299214385", "1299214385"), true);
assert.equal(isValidNaverProductName("수량"), false);
assert.equal(isValidNaverProductName("머무룸 예약하기 3"), true);
assert.equal(isValidNaverCustomerName("예약자"), false);
assert.equal(isValidNaverCustomerName("홍길동"), true);
assert.equal(isValidNaverPhone("예약번호"), false);
assert.equal(isValidNaverPhone("010-1234-5678"), true);
assert.equal(isValidNaverQuantity("옵션"), false);
assert.equal(isValidNaverQuantity("4"), true);
assert.equal(isValidNaverPaymentStatus("결제상태"), false);
assert.equal(isValidNaverPaymentStatus("결제완료"), true);
assert.equal(isValidNaverPrice("신청일시"), false);
assert.equal(isValidNaverPrice("14,400원"), true);
assert.equal(isValidNaverDateTimeParts("상품", "수량"), false);
assert.equal(isValidNaverDateTimeParts("2026. 7. 23.", "오후 12:00 ~ 오후 2:00"), true);

console.log("Naver booking row parser tests passed.");
