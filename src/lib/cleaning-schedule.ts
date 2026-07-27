export const CLEANING_ROOM_NAMES = ["머무룸1", "머무룸2", "머무룸3"] as const;

export type CleaningRoomName = (typeof CLEANING_ROOM_NAMES)[number];

export const CALENDAR_SCHEDULE_TYPES = ["CLEANING", "SITE_VISIT"] as const;
export const SITE_VISIT_SOURCES = ["naver", "spacecloud"] as const;

export type CalendarScheduleType = (typeof CALENDAR_SCHEDULE_TYPES)[number];
export type SiteVisitSource = (typeof SITE_VISIT_SOURCES)[number];

export type CleaningScheduleInput = {
  roomName: string;
  cleanerName: string;
  scheduleType: CalendarScheduleType;
  contactPhone: string | null;
  source: SiteVisitSource | null;
  startTime: Date;
  endTime: Date;
  cost: number;
  memo: string | null;
};

export function parseCleaningRoomNames(value: string): CleaningRoomName[] {
  if (value === "전체") return [...CLEANING_ROOM_NAMES];

  return value
    .split(",")
    .map((roomName) => roomName.trim())
    .filter((roomName): roomName is CleaningRoomName =>
      CLEANING_ROOM_NAMES.includes(roomName as CleaningRoomName),
    )
    .filter((roomName, index, roomNames) => roomNames.indexOf(roomName) === index);
}

export function formatCleaningRoomNames(roomNames: CleaningRoomName[]) {
  return CLEANING_ROOM_NAMES.filter((roomName) => roomNames.includes(roomName)).join(",");
}

type ValidationResult =
  | { ok: true; data: CleaningScheduleInput }
  | { ok: false; error: string };

function parseDate(value: unknown) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validateCleaningScheduleInput(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "일정 정보를 확인해 주세요." };
  }

  const input = body as Record<string, unknown>;
  const scheduleType = CALENDAR_SCHEDULE_TYPES.includes(input.scheduleType as CalendarScheduleType)
    ? input.scheduleType as CalendarScheduleType
    : "CLEANING";
  const legacyRoomNames = typeof input.roomName === "string"
    ? parseCleaningRoomNames(input.roomName.trim())
    : [];
  const roomNames = Array.isArray(input.roomNames)
    ? input.roomNames.filter((roomName): roomName is CleaningRoomName =>
        typeof roomName === "string" && CLEANING_ROOM_NAMES.includes(roomName as CleaningRoomName),
      )
    : legacyRoomNames;
  const uniqueRoomNames = CLEANING_ROOM_NAMES.filter((roomName) => roomNames.includes(roomName));
  const cleanerName = typeof input.cleanerName === "string" ? input.cleanerName.trim() : "";
  const contactPhone = typeof input.contactPhone === "string" ? input.contactPhone.trim() : "";
  const source = SITE_VISIT_SOURCES.includes(input.source as SiteVisitSource)
    ? input.source as SiteVisitSource
    : null;
  const startTime = parseDate(input.startTime);
  const endTime = parseDate(input.endTime);
  const rawCost = typeof input.cost === "string" ? Number(input.cost.replace(/,/g, "")) : Number(input.cost);
  const memo = typeof input.memo === "string" ? input.memo.trim() : "";

  if (uniqueRoomNames.length === 0) {
    return { ok: false, error: `${scheduleType === "SITE_VISIT" ? "사전답사할" : "청소할"} 공간을 하나 이상 선택해 주세요.` };
  }
  if (!cleanerName || cleanerName.length > 100) {
    return { ok: false, error: `${scheduleType === "SITE_VISIT" ? "방문자 이름" : "청소한 사람"}을 100자 이내로 입력해 주세요.` };
  }
  if (!startTime || !endTime || endTime.getTime() <= startTime.getTime()) {
    return { ok: false, error: `${scheduleType === "SITE_VISIT" ? "사전답사" : "청소"} 종료 시간은 시작 시간보다 늦어야 합니다.` };
  }
  if (scheduleType === "CLEANING" && (!Number.isInteger(rawCost) || rawCost < 0 || rawCost > 100_000_000)) {
    return { ok: false, error: "청소 비용을 올바르게 입력해 주세요." };
  }
  if (scheduleType === "SITE_VISIT" && contactPhone && !/^01[016789]-?\d{3,4}-?\d{4}$/.test(contactPhone)) {
    return { ok: false, error: "사전답사 연락처를 올바르게 입력해 주세요." };
  }
  if (scheduleType === "SITE_VISIT" && !source) {
    return { ok: false, error: "사전답사 유입 경로를 선택해 주세요." };
  }
  if (memo.length > 1000) {
    return { ok: false, error: "메모는 1,000자 이내로 입력해 주세요." };
  }

  return {
    ok: true,
    data: {
      roomName: formatCleaningRoomNames(uniqueRoomNames),
      cleanerName,
      scheduleType,
      contactPhone: scheduleType === "SITE_VISIT" ? contactPhone || null : null,
      source: scheduleType === "SITE_VISIT" ? source : null,
      startTime,
      endTime,
      cost: scheduleType === "CLEANING" ? rawCost : 0,
      memo: memo || null,
    },
  };
}
