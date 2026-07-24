import { SolapiMessageService } from "solapi";
import { prisma } from "@/lib/prisma";

export type SolapiDailyUsage = {
  available: boolean;
  totalCost: number;
  totalCount: number;
  reservation: { cost: number; count: number };
  operational: { cost: number; count: number };
  other: { cost: number; count: number };
  unpricedCount: number;
  checkedAt: string;
  error: string | null;
};

type SolapiHistoryItem = {
  messageId?: string | null;
  groupId?: string | null;
  type?: string | null;
  status?: string | null;
  statusCode?: string | null;
  text?: string | null;
  customFields?: Record<string, string> | null;
};

type UsageCategory = "reservation" | "operational" | "other";

const CACHE_TTL_MS = 60_000;
let usageCache: { key: string; expiresAt: number; value: SolapiDailyUsage } | null = null;

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function emptyUsage(error: string | null = null): SolapiDailyUsage {
  return {
    available: error === null,
    totalCost: 0,
    totalCount: 0,
    reservation: { cost: 0, count: 0 },
    operational: { cost: 0, count: 0 },
    other: { cost: 0, count: 0 },
    unpricedCount: 0,
    checkedAt: new Date().toISOString(),
    error,
  };
}

function unitPrice(price: unknown, messageType: string | null | undefined) {
  const key = messageType?.toLowerCase();
  if (!key || !price || typeof price !== "object") return null;

  for (const priceTable of Object.values(price as Record<string, unknown>)) {
    if (!priceTable || typeof priceTable !== "object") continue;
    const value = (priceTable as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function usageCategory(
  message: SolapiHistoryItem,
  stored: { reservationId: string | null; dedupeKey: string } | undefined,
): UsageCategory {
  if (stored?.dedupeKey.startsWith("reservation-test:")) return "other";
  if (message.customFields?.messageCategory === "operational") return "operational";
  if (message.customFields?.reservationId || stored?.reservationId) return "reservation";
  if (/tailscale|테일스케일|서버|장애|접속|점검|rpa/i.test(message.text || "")) return "operational";
  return "other";
}

export async function getSolapiDailyUsage(
  startDate: Date,
  endDate: Date,
): Promise<SolapiDailyUsage> {
  const cacheKey = `${startDate.toISOString()}:${endDate.toISOString()}`;
  if (usageCache?.key === cacheKey && usageCache.expiresAt > Date.now()) return usageCache.value;

  const apiKey = env("SOLAPI_API_KEY");
  const apiSecret = env("SOLAPI_API_SECRET");
  if (!apiKey || !apiSecret) return emptyUsage("솔라피 API가 설정되지 않았습니다.");

  try {
    const service = new SolapiMessageService(apiKey, apiSecret);
    const messages: SolapiHistoryItem[] = [];
    let startKey: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const response = await service.getMessages({
        dateType: "CREATED",
        startDate,
        endDate,
        limit: 100,
        ...(startKey ? { startKey } : {}),
      });
      messages.push(...Object.values(response.messageList || {}) as SolapiHistoryItem[]);
      const nextKey = typeof response.nextKey === "string" ? response.nextKey : "";
      if (!nextKey || nextKey === startKey) break;
      startKey = nextKey;
    }

    const messageIds = messages
      .map((message) => message.messageId)
      .filter((messageId): messageId is string => Boolean(messageId));
    const storedMessages = messageIds.length > 0
      ? await prisma.customerMessage.findMany({
        where: { providerMessageId: { in: messageIds } },
        select: { providerMessageId: true, reservationId: true, dedupeKey: true },
      })
      : [];
    const storedByProviderId = new Map(
      storedMessages
        .filter((message) => message.providerMessageId)
        .map((message) => [message.providerMessageId as string, message]),
    );

    const groupIds = [...new Set(messages
      .map((message) => message.groupId)
      .filter((groupId): groupId is string => Boolean(groupId)))];
    const groupPrices = new Map<string, { price: unknown; refunded: boolean }>();
    await Promise.all(groupIds.map(async (groupId) => {
      const group = await service.getGroup(groupId);
      groupPrices.set(groupId, { price: group.price, refunded: group.isRefunded });
    }));

    const result = emptyUsage();
    for (const message of messages) {
      if (message.status !== "COMPLETE" || message.statusCode !== "4000") continue;
      const group = message.groupId ? groupPrices.get(message.groupId) : null;
      const cost = group && !group.refunded ? unitPrice(group.price, message.type) : group?.refunded ? 0 : null;
      if (cost === null) {
        result.unpricedCount += 1;
        continue;
      }

      const category = usageCategory(
        message,
        message.messageId ? storedByProviderId.get(message.messageId) : undefined,
      );
      result[category].count += 1;
      result[category].cost += cost;
      result.totalCount += 1;
      result.totalCost += cost;
    }

    usageCache = {
      key: cacheKey,
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: result,
    };
    return result;
  } catch (error) {
    return emptyUsage(error instanceof Error ? error.message : String(error));
  }
}
