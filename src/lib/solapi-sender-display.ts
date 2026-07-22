const SOLAPI_SENDER_LABELS: Record<string, string> = {
  "01094431849": "짹짹공주",
  "01071835720": "뚜이왕자",
};

const SOLAPI_SENDER_ORDER: Record<string, number> = {
  "01094431849": 0,
  "01071835720": 1,
};

export function solapiSenderDisplayName(phoneNumber: string) {
  return SOLAPI_SENDER_LABELS[phoneNumber] || "등록 발신번호";
}

export function solapiSenderDisplayOrder(phoneNumber: string) {
  return SOLAPI_SENDER_ORDER[phoneNumber] ?? Number.MAX_SAFE_INTEGER;
}
