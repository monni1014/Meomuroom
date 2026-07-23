const KST_TIME_ZONE = "Asia/Seoul";
const TRIGROUND_PAID_BOOKING_PRICE = 24_000;

function kstDateKey(date: Date) {
  return date.toLocaleDateString("en-CA", { timeZone: KST_TIME_ZONE });
}

function daysBetween(fromKey: string, toKey: string) {
  const from = new Date(`${fromKey}T00:00:00+09:00`);
  const to = new Date(`${toKey}T00:00:00+09:00`);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function competitorCancellationFeeRate(
  competitorId: string,
  useDateKey: string,
  checkedAt: Date,
  bookingDurationHours: number,
) {
  // 트라이그라운드의 독립된 1시간 예약은 공유오피스 이용자에게
  // 무료로 제공되므로 취소 시에도 매출과 취소수수료가 없다.
  if (competitorId.startsWith("triground-") && bookingDurationHours <= 1) return 0;

  const remainingDays = daysBetween(kstDateKey(checkedAt), useDateKey);
  if (competitorId === "synergy") {
    if (remainingDays >= 7) return 0;
    if (remainingDays === 6) return 30;
    if (remainingDays === 5) return 50;
    if (remainingDays === 4) return 70;
    return 100;
  }

  if (remainingDays >= 2) return 0;
  if (remainingDays === 1) return 50;
  return 100;
}

export function cancellationEquivalentHours(durationHours: number, feeRate: number | null) {
  const safeDuration = Number.isFinite(durationHours) ? Math.max(0, durationHours) : 0;
  const safeRate = Number.isFinite(feeRate) ? Math.min(100, Math.max(0, feeRate || 0)) : 0;
  return Math.round(safeDuration * safeRate) / 100;
}

export function trigroundBookingRevenue(durationHours: number) {
  const safeDuration = Number.isFinite(durationHours) ? Math.max(0, durationHours) : 0;
  return safeDuration > 1 ? TRIGROUND_PAID_BOOKING_PRICE : 0;
}

export function trigroundCancellationRevenue(
  durationHours: number,
  feeRate: number | null,
) {
  if (trigroundBookingRevenue(durationHours) === 0) return 0;
  const safeRate = Number.isFinite(feeRate) ? Math.min(100, Math.max(0, feeRate || 0)) : 0;
  return Math.round(TRIGROUND_PAID_BOOKING_PRICE * safeRate / 100);
}

export function cancellationDetectedDateLabel(occurredAt: string | Date) {
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const [, month, day] = kstDateKey(date).split("-").map(Number);
  return `${month}/${day}`;
}

export function shouldDisplayZeroFeeCancellationAsNew(
  _competitorId: string,
  _durationHours: number,
  feeRate: number | null,
) {
  // 취소수수료와 매출 집계 여부는 별개다. 수수료가 0원이어도
  // 기존 예약이 사라졌다는 운영 변화는 반드시 신규 취소로 보여준다.
  return feeRate === 0;
}
