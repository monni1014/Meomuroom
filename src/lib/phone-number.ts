export function normalizeKoreanPhone(value: string | null | undefined) {
  let digits = (value || "").replace(/\D/g, "");
  if (digits.startsWith("0082")) digits = digits.slice(2);
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  return digits;
}

export function formatKoreanPhone(value: string | null | undefined) {
  const digits = normalizeKoreanPhone(value);
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value?.trim() || digits;
}
