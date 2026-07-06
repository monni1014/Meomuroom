export const CUSTOMER_TYPES = ["UNSPECIFIED", "PERSONAL", "CORPORATE"] as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  UNSPECIFIED: "미입력",
  PERSONAL: "개인",
  CORPORATE: "법인",
};

export function normalizeCustomerType(value: unknown): CustomerType {
  return CUSTOMER_TYPES.includes(value as CustomerType)
    ? (value as CustomerType)
    : "UNSPECIFIED";
}
