import { prisma } from "@/lib/prisma";

const SOLAPI_SENDER_SETTING_KEY = "solapi.senderNumber";

function env(name: string) {
  return process.env[name]?.trim() || "";
}

export function normalizeSolapiPhone(value: string | null | undefined) {
  return (value || "").replace(/\D/g, "");
}

export async function getSelectedSolapiSenderNumber() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: SOLAPI_SENDER_SETTING_KEY },
    select: { value: true },
  });
  const savedNumber = normalizeSolapiPhone(setting?.value);
  if (savedNumber) return savedNumber;
  return normalizeSolapiPhone(env("SOLAPI_FROM") || env("OWNER_PHONE")) || null;
}

export async function saveSelectedSolapiSenderNumber(senderNumber: string) {
  const normalized = normalizeSolapiPhone(senderNumber);
  if (!normalized) throw new Error("발신번호를 선택해주세요.");

  await prisma.appSetting.upsert({
    where: { key: SOLAPI_SENDER_SETTING_KEY },
    create: { key: SOLAPI_SENDER_SETTING_KEY, value: normalized },
    update: { value: normalized },
  });
  return normalized;
}
