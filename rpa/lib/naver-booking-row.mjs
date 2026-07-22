function normalizeLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function extractPhone(text) {
  const match = String(text || "").match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
}

function toMinutes(prefix, hourText, minuteText) {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (prefix === "오후" && hour !== 12) hour += 12;
  if (prefix === "오전" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function inferEndPrefix(startMinutes, endHourText, endMinuteText) {
  const candidates = ["오전", "오후"]
    .map((prefix) => ({
      prefix,
      minutes: toMinutes(prefix, endHourText, endMinuteText),
    }))
    .sort((left, right) => left.minutes - right.minutes);
  return candidates.find((candidate) => candidate.minutes > startMinutes)?.prefix
    || candidates[0].prefix;
}

export function parseNaverBookingListDateTime(value) {
  const match = String(value || "").match(
    /(\d{2,4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*\([^)]+\)\s*(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})/,
  );
  if (!match) return null;

  const [, rawYear, month, day, startPrefix, startHour, startMinute, rawEndPrefix, endHour, endMinute] = match;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const startMinutes = toMinutes(startPrefix, startHour, startMinute);
  const endPrefix = rawEndPrefix || inferEndPrefix(startMinutes, endHour, endMinute);
  const dateText = `${year}. ${Number(month)}. ${Number(day)}.`;
  const timeText = `${startPrefix} ${Number(startHour)}:${startMinute} ~ ${endPrefix} ${Number(endHour)}:${endMinute}`;

  return {
    dateText,
    timeText,
    combined: `${dateText} ${timeText}`,
  };
}

export function isValidNaverBookingNumber(value, expectedBookingId = null) {
  const normalized = String(value || "").trim();
  if (!/^\d{9,12}$/.test(normalized)) return false;
  return !expectedBookingId || normalized === String(expectedBookingId);
}

export function isValidNaverProductName(value) {
  return /머무룸\s*(?:예약하기\s*)?[123]/.test(String(value || ""));
}

export function isValidNaverCustomerName(value) {
  const normalized = String(value || "").trim();
  if (!/^[가-힣A-Za-z][가-힣A-Za-z .]{1,30}$/.test(normalized)) return false;
  return !/^(예약자|예약자명|이름|전화번호|휴대폰 번호|연락처|예약번호|상품|수량|옵션|결제상태|신청일시)$/.test(normalized);
}

export function isValidNaverPhone(value) {
  return /^01[016789]-\d{3,4}-\d{4}$/.test(String(value || "").trim());
}

export function isValidNaverQuantity(value) {
  return /^\d{1,3}$/.test(String(value || "").trim());
}

export function isValidNaverPaymentStatus(value) {
  return /^(결제완료|결제대기|환불|미결제)$/.test(String(value || "").trim());
}

export function isValidNaverPrice(value) {
  return /^[\d,]+\s*원$/.test(String(value || "").trim());
}

export function isValidNaverDateTimeParts(dateText, timeText) {
  return /^\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?/.test(String(dateText || ""))
    && /(오전|오후)\s*\d{1,2}:\d{2}\s*~\s*(오전|오후)\s*\d{1,2}:\d{2}/.test(String(timeText || ""));
}

function findCustomerName(lines, bookingIndex) {
  const ignored = /^(확정|취소|이용완료|확정대기|대리예약|예약 상세정보|닫기)$/;
  for (let index = bookingIndex - 1; index >= Math.max(0, bookingIndex - 10); index -= 1) {
    const line = lines[index];
    if (extractPhone(line) || ignored.test(line) || /^방문자\s*:/.test(line)) continue;
    if (/^[가-힣A-Za-z][가-힣A-Za-z .]{1,30}$/.test(line)) return line;
  }
  return null;
}

function findNearby(lines, startIndex, endOffset, predicate) {
  const endIndex = Math.min(lines.length, startIndex + endOffset + 1);
  for (let index = startIndex; index < endIndex; index += 1) {
    if (predicate(lines[index])) return { index, value: lines[index] };
  }
  return null;
}

export function extractNaverBookingListRow(text, bookingId) {
  if (!bookingId) return null;
  const lines = normalizeLines(text);
  const candidates = [];

  for (let bookingIndex = 0; bookingIndex < lines.length; bookingIndex += 1) {
    if (!lines[bookingIndex].includes(String(bookingId))) continue;

    const date = findNearby(lines, bookingIndex + 1, 10, (line) => Boolean(parseNaverBookingListDateTime(line)));
    if (!date) continue;
    const product = findNearby(lines, date.index + 1, 4, isValidNaverProductName);
    if (!product) continue;

    const parsedDateTime = parseNaverBookingListDateTime(date.value);
    const quantity = findNearby(lines, product.index + 1, 3, isValidNaverQuantity);
    const paymentStatus = findNearby(
      lines,
      (quantity?.index ?? product.index) + 1,
      6,
      isValidNaverPaymentStatus,
    );
    const price = findNearby(
      lines,
      (paymentStatus?.index ?? quantity?.index ?? product.index) + 1,
      5,
      isValidNaverPrice,
    );
    const status = [...lines.slice(Math.max(0, bookingIndex - 10), bookingIndex)]
      .reverse()
      .find((line) => /^(확정|취소|이용완료|확정대기)$/.test(line)) || null;
    const phone = [...lines.slice(Math.max(0, bookingIndex - 6), bookingIndex + 1)]
      .reverse()
      .map(extractPhone)
      .find(Boolean) || null;

    candidates.push({
      bookingNumber: String(bookingId),
      bookingStatus: status,
      customerName: findCustomerName(lines, bookingIndex),
      phone,
      productName: product.value,
      useDateTime: parsedDateTime?.combined || null,
      useDateText: parsedDateTime?.dateText || null,
      useTimeText: parsedDateTime?.timeText || null,
      quantity: quantity?.value || null,
      paymentStatus: paymentStatus?.value || null,
      priceText: price?.value || null,
      score: (date.index - bookingIndex) + (product.index - date.index),
    });
  }

  return candidates.sort((left, right) => left.score - right.score)[0] || null;
}
