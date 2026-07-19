import { prisma } from "@/lib/prisma";
import type { ProxyPaymentCurrency, ProxyPaymentRecord } from "@/lib/proxy-payment-types";
import { getKstDateKey } from "@/lib/kst-time";

const SUPPORTED_CURRENCIES = new Set<ProxyPaymentCurrency>(["USD", "KRW"]);

function dateOnly(value: Date | null) {
  return value ? getKstDateKey(value) : null;
}

function parseDateOnly(value: unknown, fieldName: string, required: true): Date;
function parseDateOnly(value: unknown, fieldName: string, required?: false): Date | null;
function parseDateOnly(value: unknown, fieldName: string, required = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (required) throw new Error(`${fieldName}을(를) 확인해 주세요.`);
    return null;
  }

  const date = new Date(`${value}T12:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName}을(를) 확인해 주세요.`);
  return date;
}

function normalizeCurrency(value: unknown): ProxyPaymentCurrency {
  const currency = typeof value === "string" ? value.toUpperCase() as ProxyPaymentCurrency : "USD";
  if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error("지원하지 않는 통화입니다.");
  return currency;
}

function parseAmountMinor(value: unknown, currency: ProxyPaymentCurrency) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("결제액을 확인해 주세요.");

  const amountMinor = currency === "KRW" ? Math.round(amount) : Math.round(amount * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("결제액을 확인해 주세요.");
  return amountMinor;
}

function serializePayment(payment: {
  id: string;
  provider: string;
  paidOn: Date;
  amountMinor: number;
  currency: string;
  vatIncluded: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ProxyPaymentRecord {
  return {
    id: payment.id,
    provider: payment.provider,
    paidOn: dateOnly(payment.paidOn)!,
    amountMinor: payment.amountMinor,
    currency: normalizeCurrency(payment.currency),
    vatIncluded: payment.vatIncluded,
    periodStart: dateOnly(payment.periodStart),
    periodEnd: dateOnly(payment.periodEnd),
    note: payment.note,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

export async function getProxyPayments() {
  const payments = await prisma.proxyPayment.findMany({
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
  });
  return payments.map(serializePayment);
}

export async function createProxyPayment(input: Record<string, unknown>) {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  if (!provider || provider.length > 60) throw new Error("프록시 업체명을 확인해 주세요.");

  const currency = normalizeCurrency(input.currency);
  const paidOn = parseDateOnly(input.paidOn, "결제일", true);
  const periodStart = parseDateOnly(input.periodStart, "사용 시작일");
  const periodEnd = parseDateOnly(input.periodEnd, "사용 종료일");
  if (periodStart && periodEnd && periodEnd < periodStart) {
    throw new Error("사용 종료일은 시작일보다 빠를 수 없습니다.");
  }

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 200) throw new Error("메모는 200자 이내로 입력해 주세요.");

  const payment = await prisma.proxyPayment.create({
    data: {
      provider,
      paidOn,
      amountMinor: parseAmountMinor(input.amount, currency),
      currency,
      vatIncluded: input.vatIncluded !== false,
      periodStart,
      periodEnd,
      note: note || null,
    },
  });

  return serializePayment(payment);
}

export async function deleteProxyPayment(id: string) {
  if (!id) throw new Error("삭제할 결제 내역이 없습니다.");
  await prisma.proxyPayment.delete({ where: { id } });
}
