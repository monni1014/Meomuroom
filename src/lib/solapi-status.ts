import crypto from "crypto";
import { SolapiMessageService } from "solapi";

const SOLAPI_API_BASE_URL = "https://api.solapi.com";

export type SolapiSenderStatus = {
  handleKey: string | null;
  phoneNumber: string;
  status: string | null;
  method: string | null;
  expireAt: string | null;
  autoExtension: boolean | null;
  necessaryMeasures: string[] | null;
  consignment: boolean | null;
  dateCreated: string | null;
  dateUpdated: string | null;
};

export type SolapiServiceStatus = {
  configured: boolean;
  senderNumber: string | null;
  balance: number | null;
  point: number | null;
  minimumCash: number | null;
  lowBalanceAlert: unknown | null;
  sender: SolapiSenderStatus | null;
  senderLimit: number | null;
  checkedAt: string;
  error: string | null;
};

type SenderIdResponse = {
  limit?: number;
  senderIds?: Array<{
    handleKey?: string;
    phoneNumber?: string;
    status?: string;
    method?: string | null;
    expireAt?: string | null;
    autoExtension?: boolean;
    necessaryMeasures?: string[] | null;
    consignment?: boolean;
    dateCreated?: string;
    dateUpdated?: string;
  }>;
};

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function normalizePhone(value: string | null | undefined) {
  return (value || "").replace(/\D/g, "");
}

function buildSolapiAuthHeader(apiKey: string, apiSecret: string) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function getSenderIds(apiKey: string, apiSecret: string) {
  const response = await fetch(`${SOLAPI_API_BASE_URL}/senderid/v1/numbers`, {
    method: "GET",
    headers: {
      Authorization: buildSolapiAuthHeader(apiKey, apiSecret),
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Solapi sender number check failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return JSON.parse(text) as SenderIdResponse;
}

function toSenderStatus(sender: NonNullable<SenderIdResponse["senderIds"]>[number]): SolapiSenderStatus | null {
  const phoneNumber = normalizePhone(sender.phoneNumber);
  if (!phoneNumber) return null;

  return {
    handleKey: sender.handleKey || null,
    phoneNumber,
    status: sender.status || null,
    method: sender.method || null,
    expireAt: sender.expireAt || env("SOLAPI_SENDER_RENEWAL_DATE") || null,
    autoExtension: typeof sender.autoExtension === "boolean" ? sender.autoExtension : null,
    necessaryMeasures: sender.necessaryMeasures || null,
    consignment: typeof sender.consignment === "boolean" ? sender.consignment : null,
    dateCreated: sender.dateCreated || null,
    dateUpdated: sender.dateUpdated || null,
  };
}

export async function getSolapiServiceStatus(): Promise<SolapiServiceStatus> {
  const apiKey = env("SOLAPI_API_KEY");
  const apiSecret = env("SOLAPI_API_SECRET");
  const senderNumber = normalizePhone(env("SOLAPI_FROM") || env("OWNER_PHONE")) || null;
  const checkedAt = new Date().toISOString();

  if (!apiKey || !apiSecret) {
    return {
      configured: false,
      senderNumber,
      balance: null,
      point: null,
      minimumCash: null,
      lowBalanceAlert: null,
      sender: null,
      senderLimit: null,
      checkedAt,
      error: "SOLAPI_API_KEY 또는 SOLAPI_API_SECRET이 설정되지 않았습니다.",
    };
  }

  try {
    const service = new SolapiMessageService(apiKey, apiSecret);
    const [balance, senderIds] = await Promise.all([
      service.getBalance(),
      getSenderIds(apiKey, apiSecret),
    ]);

    const normalizedSender = senderNumber;
    const senderList = senderIds.senderIds
      ?.map(toSenderStatus)
      .filter((item): item is SolapiSenderStatus => item !== null) || [];
    const sender = senderList.find((item) => item.phoneNumber === normalizedSender) || senderList[0] || null;

    return {
      configured: true,
      senderNumber,
      balance: Number.isFinite(balance.balance) ? balance.balance : null,
      point: Number.isFinite(balance.point) ? balance.point : null,
      minimumCash: typeof balance.minimumCash === "number" ? balance.minimumCash : null,
      lowBalanceAlert: balance.lowBalanceAlert || null,
      sender,
      senderLimit: typeof senderIds.limit === "number" ? senderIds.limit : null,
      checkedAt,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      senderNumber,
      balance: null,
      point: null,
      minimumCash: null,
      lowBalanceAlert: null,
      sender: null,
      senderLimit: null,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
