export type ProxyPaymentCurrency = "USD" | "KRW";

export type ProxyPaymentRecord = {
  id: string;
  provider: string;
  paidOn: string;
  amountMinor: number;
  currency: ProxyPaymentCurrency;
  vatIncluded: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
