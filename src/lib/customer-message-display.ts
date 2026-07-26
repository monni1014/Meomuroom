export type CustomerMessageDisplayType = "GUIDE" | "DAWN_BOOKING" | "UNPAID" | "SITUATION";

export type CustomerMessageDisplay = {
  type: CustomerMessageDisplayType;
  label: string;
};

export function customerMessageDisplay(dedupeKey: string): CustomerMessageDisplay {
  if (dedupeKey.startsWith("situation:dawn-booking:")) {
    return { type: "DAWN_BOOKING", label: "새벽시간 확인" };
  }
  if (dedupeKey.startsWith("situation:unpaid:")) {
    return { type: "UNPAID", label: "미정산 안내" };
  }
  if (dedupeKey.startsWith("situation:")) {
    return { type: "SITUATION", label: "상황별 안내" };
  }
  return { type: "GUIDE", label: "이용 안내" };
}
