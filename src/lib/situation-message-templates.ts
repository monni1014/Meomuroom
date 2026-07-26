import { prisma } from "@/lib/prisma";

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
    automationDescription: "같은 고객의 연속 예약은 제외합니다. 발송 시점을 확정한 뒤 정시퇴실 자동발송에 연결합니다.",
  },
  {
    key: "UNPAID_RESERVATION",
    name: "미정산 안내",
    triggerDescription: "예약이 미정산 상태인 경우",
    automationDescription: "발송 시점을 확정한 뒤 미정산 자동발송에 연결합니다.",
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
  updatedAt: Date | null;
};

type StoredSituationMessageTemplate = {
  subject?: unknown;
  content?: unknown;
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

function parseStoredTemplate(value: string | undefined) {
  if (!value) return { subject: "", content: "" };

  try {
    const parsed = JSON.parse(value) as StoredSituationMessageTemplate;
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
    };
  } catch {
    return { subject: "", content: "" };
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
    const stored = parseStoredTemplate(setting?.value);
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
): Promise<SituationMessageTemplate> {
  const definition = SITUATION_MESSAGE_TEMPLATE_DEFINITIONS.find((item) => item.key === key);
  if (!definition) throw new Error(`Unknown situation message template: ${key}`);

  const stored = await prisma.appSetting.upsert({
    where: { key: settingKey(key) },
    create: {
      key: settingKey(key),
      value: JSON.stringify({ subject: subject.trim(), content: content.trim() }),
    },
    update: {
      value: JSON.stringify({ subject: subject.trim(), content: content.trim() }),
    },
    select: { value: true, updatedAt: true },
  });
  const template = parseStoredTemplate(stored.value);

  return {
    ...definition,
    ...template,
    updatedAt: stored.updatedAt,
  };
}
