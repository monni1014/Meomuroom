export const CLEANING_ROOM_NAMES = ["전체", "머무룸1", "머무룸2", "머무룸3"] as const;

export type CleaningScheduleInput = {
  roomName: (typeof CLEANING_ROOM_NAMES)[number];
  cleanerName: string;
  startTime: Date;
  endTime: Date;
  cost: number;
  memo: string | null;
};

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
    return { ok: false, error: "청소 일정 정보를 확인해 주세요." };
  }

  const input = body as Record<string, unknown>;
  const roomName = typeof input.roomName === "string" ? input.roomName.trim() : "";
  const cleanerName = typeof input.cleanerName === "string" ? input.cleanerName.trim() : "";
  const startTime = parseDate(input.startTime);
  const endTime = parseDate(input.endTime);
  const rawCost = typeof input.cost === "string" ? Number(input.cost.replace(/,/g, "")) : Number(input.cost);
  const memo = typeof input.memo === "string" ? input.memo.trim() : "";

  if (!CLEANING_ROOM_NAMES.includes(roomName as CleaningScheduleInput["roomName"])) {
    return { ok: false, error: "청소 공간을 확인해 주세요." };
  }
  if (!cleanerName || cleanerName.length > 100) {
    return { ok: false, error: "청소한 사람을 100자 이내로 입력해 주세요." };
  }
  if (!startTime || !endTime || endTime.getTime() <= startTime.getTime()) {
    return { ok: false, error: "청소 종료 시간은 시작 시간보다 늦어야 합니다." };
  }
  if (!Number.isInteger(rawCost) || rawCost < 0 || rawCost > 100_000_000) {
    return { ok: false, error: "청소 비용을 올바르게 입력해 주세요." };
  }
  if (memo.length > 1000) {
    return { ok: false, error: "메모는 1,000자 이내로 입력해 주세요." };
  }

  return {
    ok: true,
    data: {
      roomName: roomName as CleaningScheduleInput["roomName"],
      cleanerName,
      startTime,
      endTime,
      cost: rawCost,
      memo: memo || null,
    },
  };
}
