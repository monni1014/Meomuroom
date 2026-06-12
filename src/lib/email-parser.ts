import { format, parse } from 'date-fns';

export interface ParsedReservation {
  source: string;       // "naver" | "spacecloud"
  roomName: string;     // "머무룸1" | "머무룸2"
  customerName: string; // 고객명
  startTime: Date;
  endTime: Date;
  price: number;          // 최종 매출액 (쿠폰 할인 적용 후)
  discount?: number;      // 사용한 쿠폰/할인 금액 (원가 - 최종가)
  headCount: number;
  emailId: string;
  isCancelled?: boolean;  // 취소 메일 여부
  refundFee?: number;     // 환불수수료 (취소 시 매출로 반영)
}

/**
 * 스페이스클라우드 메일 파서
 */
export function parseSpaceCloudEmail(subject: string, text: string, messageId: string): ParsedReservation | null {
  try {
    // 1. 공간 추출 ("예약하기 1/2/3" - 제목 또는 본문 머리글에 등장)
    const roomSource = `${subject} ${text}`;
    let roomName = "머무룸1";
    if (/(머무룸\s*(?:회의실\s*)?2|2호점|예약하기\s*2)/.test(roomSource)) {
      roomName = "머무룸2";
    } else if (/(머무룸\s*(?:회의실\s*)?3|3호점|예약하기\s*3)/.test(roomSource)) {
      roomName = "머무룸3";
    }

    // 2. 예약내용 (시간) 추출: "2026/06/11 17시 - 21시"
    const timeMatch = text.match(/예약내용\s+(\d{4}\/\d{2}\/\d{2})\s+(\d+)시\s*-\s*(\d+)시/);
    if (!timeMatch) return null;
    
    const dateStr = timeMatch[1];
    const startHour = parseInt(timeMatch[2], 10);
    const endHour = parseInt(timeMatch[3], 10);

    const startTime = parse(`${dateStr} ${startHour}:00`, 'yyyy/MM/dd HH:mm', new Date());
    const endTime = parse(`${dateStr} ${endHour}:00`, 'yyyy/MM/dd HH:mm', new Date());

    // 3. 인원 추출: "예약인원 5명" 또는 "이용인원 10명" 둘 다 지원
    const headMatch = text.match(/(?:예약인원|이용인원)\s+(\d+)명/);
    const headCount = headMatch ? parseInt(headMatch[1], 10) : 1;

    // 4. 예약자명 추출: "양진우"
    //    취소 메일은 "예약자명 양진우 결제예정금액 ..."처럼 뒤 필드가 같은 줄에 붙어오므로
    //    "결제"가 나오기 전 또는 줄바꿈 전까지만 잘라낸다.
    const nameMatch = text.match(/예약자명\s+(.+?)(?=\s*결제|\n|$)/);
    const customerName = nameMatch ? nameMatch[1].trim() : "스페이스클라우드 예약";

    // 5. 금액 추출: "₩100,000" / 취소 메일은 "결제예정금액 ₩25,000"
    const priceMatch = text.match(/결제(?:예정)?금액\s+[^\d]*([\d,]+)/);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : 0;

    // 6. 취소 메일 여부 추출
    //    참고: 스페이스클라우드 취소 메일 하단의 '결제예정금액'은 실제 환불수수료와
    //    다를 수 있다(정확한 수수료는 '호스트센터'에서 확인해야 함). 그래서 메일값을
    //    매출로 자동 반영하지 않는다. → 취소 시 매출은 0, 필요하면 수기 입력.
    const isCancelled = /예약이\s*취소|취소되었습니다|취소일|취소사유/.test(text) || subject.includes("취소");
    const refundFee = 0;

    return {
      source: "spacecloud",
      roomName,
      customerName,
      startTime,
      endTime,
      price,
      headCount,
      emailId: messageId,
      isCancelled,
      refundFee,
    };
  } catch (e) {
    console.error("SpaceCloud 파싱 에러:", e);
    return null;
  }
}

/**
 * 네이버플레이스 메일 파서
 */
export function parseNaverEmail(subject: string, text: string, messageId: string): ParsedReservation | null {
  try {
    const roomSource = `${subject} ${text}`;
    let roomName = "머무룸1";
    if (/(머무룸\s*(?:회의실\s*)?2|2호점|예약하기\s*2)/.test(roomSource)) {
      roomName = "머무룸2";
    } else if (/(머무룸\s*(?:회의실\s*)?3|3호점|예약하기\s*3)/.test(roomSource)) {
      roomName = "머무룸3";
    }

    // 2. 금액 및 인원 추출
    //    기본형: "결제금액 머무룸 예약하기 1(1) 24,000원"
    //    쿠폰형: "결제금액 머무룸 예약하기 2(6) 45,000원 = 44,000원"
    //      → 왼쪽(45,000)은 원가, "=" 뒤(44,000)가 최종 매출, 차액(1,000)이 쿠폰 할인
    const priceMatch = text.match(/결제\s*금액\s*.*?\(\s*(\d+)\s*\)\s*([\d,]+)원(?:\s*=\s*([\d,]+)원)?/);
    let headCount = 1;
    let price = 0;     // 최종 매출액
    let discount = 0;  // 쿠폰/할인 금액
    if (priceMatch) {
      headCount = parseInt(priceMatch[1], 10);
      const originalPrice = parseInt(priceMatch[2].replace(/,/g, ''), 10);
      const finalPrice = priceMatch[3] ? parseInt(priceMatch[3].replace(/,/g, ''), 10) : originalPrice;
      price = finalPrice;
      discount = Math.max(0, originalPrice - finalPrice); // 음수 방지
    } else {
      // 대안 정규식 (형식이 조금 다를 경우 대비)
      const fallbackPriceMatch = text.match(/([\d,]+)원/);
      if (fallbackPriceMatch) price = parseInt(fallbackPriceMatch[1].replace(/,/g, ''), 10);

      const fallbackHeadMatch = text.match(/\(\s*(\d+)\s*\)/);
      if (fallbackHeadMatch) headCount = parseInt(fallbackHeadMatch[1], 10);
    }

    // 3. 시간 추출: "예약일시 2026.06.03(화) 오후 6:00~오후 7:30" 또는 "이용일시 2026.06.29.(월) 오전 1:00~오전 3:00"
    const timeMatch = text.match(/(?:예약일시|이용일시)\s+(\d{4}\.\d{2}\.\d{2}).*?(오전|오후)\s*(\d+):(\d+)\s*~\s*(오전|오후)\s*(\d+):(\d+)/);
    if (!timeMatch) return null;

    const dateStr = timeMatch[1].replace(/\./g, '/'); // 2026/06/03
    
    let startHour = parseInt(timeMatch[3], 10);
    if (timeMatch[2] === "오후" && startHour !== 12) startHour += 12;
    if (timeMatch[2] === "오전" && startHour === 12) startHour = 0;
    const startMin = parseInt(timeMatch[4], 10);

    let endHour = parseInt(timeMatch[6], 10);
    if (timeMatch[5] === "오후" && endHour !== 12) endHour += 12;
    if (timeMatch[5] === "오전" && endHour === 12) endHour = 0;
    const endMin = parseInt(timeMatch[7], 10);

    const startTime = new Date(`${dateStr} ${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00`);
    const endTime = new Date(`${dateStr} ${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00`);

    // 4. 예약자명 추출: "예약자명 양*우님"
    const nameMatch = text.match(/예약자명\s+([^\n]+)님/);
    const customerName = nameMatch ? nameMatch[1].trim() : "네이버 예약";

    // 5. 취소 메일 여부 및 환불수수료 추출
    //    예) "환불수수료 15,000원(결제금액의 100%)"
    const isCancelled = /취소/.test(subject) || /예약을\s*취소|취소되었습니다|환불수수료/.test(text);
    let refundFee = 0;
    if (isCancelled) {
      const feeMatch = text.match(/환불수수료\s*([\d,]+)원/);
      if (feeMatch) refundFee = parseInt(feeMatch[1].replace(/,/g, ''), 10);
    }

    return {
      source: "naver",
      roomName,
      customerName,
      startTime,
      endTime,
      price,
      discount,
      headCount,
      emailId: messageId,
      isCancelled,
      refundFee,
    };
  } catch (e) {
    console.error("Naver 파싱 에러:", e);
    return null;
  }
}

/**
 * 통합 파서
 */
export function parseEmail(subject: string, text: string, messageId: string): ParsedReservation | null {
  // 스페이스클라우드 판별
  if (subject.includes("스페이스클라우드") || text.includes("스페이스클라우드") || subject.includes("호스트님")) {
    return parseSpaceCloudEmail(subject, text, messageId);
  }
  
  // 네이버 판별 (예약 확정 + 예약 취소 메일 모두 포함)
  if (
    subject.includes("네이버 예약") || text.includes("네이버 예약") ||
    subject.includes("확정 되었습니다") ||
    subject.includes("취소") || text.includes("환불수수료")
  ) {
    return parseNaverEmail(subject, text, messageId);
  }

  return null; // 알 수 없는 메일
}
