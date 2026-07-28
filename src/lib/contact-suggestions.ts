export interface ContactHistoryEntry {
  name: string | null | undefined;
  phone: string | null | undefined;
  usedAt: string | Date | null | undefined;
  context?: string | null;
}

export interface ContactSuggestion {
  name: string;
  phone: string;
  lastUsedAt: number;
  contexts: string[];
}

function normalizePhone(value: string | null | undefined) {
  let digits = (value || "").replace(/\D/g, "");
  if (digits.startsWith("0082")) digits = digits.slice(2);
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  return digits;
}

function isValidMobilePhone(value: string | null | undefined) {
  return /^01[016789]\d{7,8}$/.test(normalizePhone(value));
}

function formatPhone(value: string | null | undefined) {
  const digits = normalizePhone(value);
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return value?.trim() || digits;
}

function normalizeName(value: string | null | undefined) {
  return (value || "").trim().replace(/\s+/g, " ");
}

function comparableName(value: string | null | undefined) {
  return normalizeName(value).toLocaleLowerCase("ko-KR");
}

function isUsableName(value: string) {
  return Boolean(value)
    && !value.includes("*")
    && !["미지정", "이름 미입력", "네이버 예약", "스페이스클라우드 예약"].includes(value);
}

function usedAtTimestamp(value: string | Date | null | undefined) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildContactSuggestions(entries: ContactHistoryEntry[]) {
  const contacts = new Map<string, ContactSuggestion>();

  for (const entry of entries) {
    const name = normalizeName(entry.name);
    if (!isUsableName(name) || !isValidMobilePhone(entry.phone)) continue;

    const normalizedPhone = normalizePhone(entry.phone);
    const key = `${comparableName(name)}\0${normalizedPhone}`;
    const timestamp = usedAtTimestamp(entry.usedAt);
    const context = normalizeName(entry.context);
    const existing = contacts.get(key);

    if (!existing) {
      contacts.set(key, {
        name,
        phone: formatPhone(normalizedPhone),
        lastUsedAt: timestamp,
        contexts: context ? [context] : [],
      });
      continue;
    }

    if (timestamp > existing.lastUsedAt) {
      existing.name = name;
      existing.lastUsedAt = timestamp;
    }
    if (context && !existing.contexts.includes(context)) existing.contexts.push(context);
  }

  return Array.from(contacts.values()).sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

export function findContactSuggestions(
  contacts: ContactSuggestion[],
  query: string,
  limit = 5,
) {
  const normalizedQuery = comparableName(query);
  if (!normalizedQuery) return [];

  return contacts
    .filter((contact) => comparableName(contact.name).includes(normalizedQuery))
    .sort((left, right) => {
      const leftName = comparableName(left.name);
      const rightName = comparableName(right.name);
      const leftRank = leftName === normalizedQuery ? 0 : leftName.startsWith(normalizedQuery) ? 1 : 2;
      const rightRank = rightName === normalizedQuery ? 0 : rightName.startsWith(normalizedQuery) ? 1 : 2;
      return leftRank - rightRank || right.lastUsedAt - left.lastUsedAt;
    })
    .slice(0, Math.max(0, limit));
}
