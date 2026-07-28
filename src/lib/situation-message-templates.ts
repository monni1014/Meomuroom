import { prisma } from "@/lib/prisma";
import { CLEANING_ROOM_NAMES, type CleaningRoomName } from "@/lib/cleaning-schedule";

export const SITUATION_MESSAGE_TEMPLATE_DEFINITIONS = [
  {
    key: "DAWN_BOOKING_CONFIRMATION",
    name: "새벽 시간 예약 확인",
    triggerDescription: "예약 이용 시작 시간이 한국시간 01:00~07:00인 경우",
    automationDescription: "오전·오후 착오를 먼저 확인하고, 시간 변경 시 낮 시간 요금과의 결제 차액도 안내해야 합니다.",
  },
  {
    key: "ON_TIME_EXIT_REMINDER",
    name: "정시퇴실 안내",
    triggerDescription: "같은 공간에 다른 고객의 예약이 바로 이어지는 경우",
    automationDescription: "같은 고객의 연속 예약은 제외하고, 문자현황에서 버튼을 누르면 별도 문자로 즉시 발송합니다.",
  },
  {
    key: "SITE_VISIT_GUIDE",
    name: "사전답사 안내",
    triggerDescription: "캘린더에 등록된 사전답사 일정 시작 2시간 전",
    automationDescription: "2시간 이내에 등록한 사전답사는 전화번호 확인 후 바로 자동발송합니다.",
  },
  {
    key: "UNPAID_RESERVATION",
    name: "미정산 안내",
    triggerDescription: "예약이 미정산 상태인 경우",
    automationDescription: "발송 시점을 확정한 뒤 미정산 자동발송에 연결합니다.",
  },
  {
    key: "REVIEW_REFUND_ACCOUNT_REQUEST",
    name: "리뷰 환급 계좌 요청",
    triggerDescription: "방문자·블로그 리뷰의 작성 완료를 처음 체크하고 이용현황을 저장한 경우",
    automationDescription: "고객에게 리뷰 환급을 받을 계좌정보를 요청하는 문자를 한 번만 자동 발송합니다.",
  },
] as const;

export type SituationMessageTemplateKey =
  (typeof SITUATION_MESSAGE_TEMPLATE_DEFINITIONS)[number]["key"];

export type SituationMessageTemplate = {
  key: SituationMessageTemplateKey;
  name: string;
  triggerDescription: string;
  automationDescription: string;
  subject: string;
  content: string;
  roomContents: SiteVisitRoomContents | null;
  updatedAt: Date | null;
};

export type SiteVisitRoomContents = Record<CleaningRoomName, string>;

type StoredSituationMessageTemplate = {
  subject?: unknown;
  content?: unknown;
  roomContents?: unknown;
};

const SETTING_PREFIX = "messageTemplate.situation.";

function settingKey(key: SituationMessageTemplateKey) {
  return `${SETTING_PREFIX}${key}`;
}

export function isSituationMessageTemplateKey(
  value: string,
): value is SituationMessageTemplateKey {
  return SITUATION_MESSAGE_TEMPLATE_DEFINITIONS.some((definition) => definition.key === value);
}

function siteVisitRoomContents(value: unknown, fallbackContent = ""): SiteVisitRoomContents {
  const stored = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  return {
    머무룸1: typeof stored.머무룸1 === "string" ? stored.머무룸1 : fallbackContent,
    머무룸2: typeof stored.머무룸2 === "string" ? stored.머무룸2 : fallbackContent,
    머무룸3: typeof stored.머무룸3 === "string" ? stored.머무룸3 : fallbackContent,
  };
}

function parseStoredTemplate(key: SituationMessageTemplateKey, value: string | undefined) {
  if (!value) {
    return {
      subject: "",
      content: "",
      roomContents: key === "SITE_VISIT_GUIDE" ? siteVisitRoomContents(null) : null,
    };
  }

  try {
    const parsed = JSON.parse(value) as StoredSituationMessageTemplate;
    const content = typeof parsed.content === "string" ? parsed.content : "";
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      content,
      roomContents: key === "SITE_VISIT_GUIDE"
        ? siteVisitRoomContents(parsed.roomContents, content)
        : null,
    };
  } catch {
    return {
      subject: "",
      content: "",
      roomContents: key === "SITE_VISIT_GUIDE" ? siteVisitRoomContents(null) : null,
    };
  }
}

export async function getSituationMessageTemplates(): Promise<SituationMessageTemplate[]> {
  const settings = await prisma.appSetting.findMany({
    where: { key: { startsWith: SETTING_PREFIX } },
    select: { key: true, value: true, updatedAt: true },
  });
  const settingsByKey = new Map(settings.map((setting) => [setting.key, setting]));

  return SITUATION_MESSAGE_TEMPLATE_DEFINITIONS.map((definition) => {
    const setting = settingsByKey.get(settingKey(definition.key));
    const stored = parseStoredTemplate(definition.key, setting?.value);
    return {
      ...definition,
      ...stored,
      updatedAt: setting?.updatedAt || null,
    };
  });
}

export async function updateSituationMessageTemplate(
  key: SituationMessageTemplateKey,
  subject: string,
  content: string,
  roomContents?: Partial<Record<CleaningRoomName, string>> | null,
): Promise<SituationMessageTemplate> {
  const definition = SITUATION_MESSAGE_TEMPLATE_DEFINITIONS.find((item) => item.key === key);
  if (!definition) throw new Error(`Unknown situation message template: ${key}`);

  const normalizedRoomContents = key === "SITE_VISIT_GUIDE"
    ? siteVisitRoomContents(roomContents, content)
    : null;
  const normalizedContent = key === "SITE_VISIT_GUIDE"
    ? normalizedRoomContents?.머무룸1 || ""
    : content.trim();
  const storedValue = {
    subject: subject.trim(),
    content: normalizedContent,
    ...(normalizedRoomContents
      ? {
          roomContents: Object.fromEntries(
            CLEANING_ROOM_NAMES.map((roomName) => [roomName, normalizedRoomContents[roomName].trim()]),
          ),
        }
      : {}),
  };

  const stored = await prisma.appSetting.upsert({
    where: { key: settingKey(key) },
    create: {
      key: settingKey(key),
      value: JSON.stringify(storedValue),
    },
    update: {
      value: JSON.stringify(storedValue),
    },
    select: { value: true, updatedAt: true },
  });
  const template = parseStoredTemplate(key, stored.value);

  return {
    ...definition,
    ...template,
    updatedAt: stored.updatedAt,
  };
}
