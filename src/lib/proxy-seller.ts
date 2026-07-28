import "server-only";

import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createAdminAlert, resolveAdminAlertsByType } from "@/lib/admin-alerts";
import {
  PROXY_CONNECTION_CONFIRM_DELAYS_MS,
  PROXY_OUTAGE_ALERT_REPEAT_MS,
  shouldConfirmProxyConnectionFailure,
} from "@/lib/proxy-health-alert-policy";
import type { IspProxyStatus, ProxyHealthSeverity } from "@/lib/proxy-status-types";

const PROXYSELLER_API_BASE = "https://proxy-seller.com/personal/api/v1";
const IP_CHECK_URL = "https://ipinfo.io/json";
const CACHE_MS = 5 * 60 * 1000;
const ALERT_TYPE = "ISP_PROXY_STATUS";

type ProxySellerItem = Record<string, unknown>;

type ManagementStatus = {
  ok: boolean;
  status: string | null;
  country: string | null;
  expiresOn: string | null;
  daysRemaining: number | null;
  autoRenew: boolean | null;
  autoRenewPeriod: string | null;
  ip: string | null;
  error: string | null;
};

type ConnectionStatus = {
  ok: boolean;
  ip: string | null;
  country: string | null;
  organization: string | null;
  error: string | null;
};

let cachedStatus: { value: IspProxyStatus; expiresAt: number } | null = null;
let inFlight: Promise<IspProxyStatus> | null = null;

function readEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function maskIp(ip: string | null) {
  if (!ip) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return "확인됨";
  return `${parts[0]}.${parts[1]}.x.x`;
}

function normalizeCountry(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "KR" || normalized === "KOR" || normalized.includes("SOUTH KOREA")) return "KR";
  return normalized;
}

function parseProxySellerDate(value: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function daysUntil(dateOnly: string | null) {
  if (!dateOnly) return null;
  const [year, month, day] = dateOnly.split("-").map(Number);
  if (!year || !month || !day) return null;

  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()).split("-").map(Number);

  const todayUtc = Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]);
  const expiryUtc = Date.UTC(year, month - 1, day);
  return Math.round((expiryUtc - todayUtc) / 86_400_000);
}

function isActiveStatus(status: string | null) {
  if (!status) return false;
  return ["ACTIVE", "ACTIVATED", "ON", "WORKING"].includes(status.trim().toUpperCase());
}

async function fetchManagementStatus(apiKey: string, expectedIp: string): Promise<ManagementStatus> {
  if (!apiKey) {
    return {
      ok: false,
      status: null,
      country: null,
      expiresOn: null,
      daysRemaining: null,
      autoRenew: null,
      autoRenewPeriod: null,
      ip: null,
      error: "Proxy-Seller API 키가 설정되지 않았습니다.",
    };
  }

  try {
    const response = await fetch(
      `${PROXYSELLER_API_BASE}/${encodeURIComponent(apiKey)}/proxy/list/isp?latest=Y`,
      {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      },
    );

    if (!response.ok) throw new Error(`관리 API 응답 오류 (${response.status})`);

    const payload = await response.json() as {
      status?: string;
      data?: { items?: ProxySellerItem[] | Record<string, ProxySellerItem> };
      errors?: Array<{ message?: string }>;
    };

    if (payload.status !== "success") {
      const apiMessage = payload.errors?.map((item) => item.message).filter(Boolean).join(", ");
      throw new Error(apiMessage || "관리 API가 오류를 반환했습니다.");
    }

    const rawItems = payload.data?.items;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? Object.values(rawItems) : [];
    if (items.length === 0) throw new Error("활성 ISP 프록시 주문을 찾지 못했습니다.");

    const item = items.find((candidate) => {
      const itemIp = safeString(candidate.ip_only) || safeString(candidate.ip);
      return Boolean(expectedIp && itemIp === expectedIp);
    }) || items[0];

    const status = safeString(item.status) || safeString(item.status_type);
    const country = safeString(item.country) || safeString(item.country_alpha3);
    const dateText = safeString(item.date_end) || safeString(item.expire_at);
    const expiresOn = parseProxySellerDate(dateText) || dateText;
    const autoRenewRaw = safeString(item.auto_renew)?.toUpperCase();
    const autoRenew = autoRenewRaw ? ["Y", "YES", "TRUE", "ON", "1"].includes(autoRenewRaw) : false;

    return {
      ok: isActiveStatus(status),
      status,
      country,
      expiresOn,
      daysRemaining: daysUntil(expiresOn),
      autoRenew,
      autoRenewPeriod: safeString(item.auto_renew_period),
      ip: safeString(item.ip_only) || safeString(item.ip),
      error: isActiveStatus(status) ? null : `ISP 프록시 주문 상태가 ${status || "확인불가"}입니다.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /401|403|unauthor|forbidden/i.test(message)
      ? "관리 API 인증을 확인해 주세요."
      : /timeout|시간.*초과/i.test(message)
        ? "관리 API 응답 시간이 초과되었습니다."
        : "관리 API 확인에 실패했습니다.";
    return {
      ok: false,
      status: null,
      country: null,
      expiresOn: null,
      daysRemaining: null,
      autoRenew: null,
      autoRenewPeriod: null,
      ip: null,
      error: reason,
    };
  }
}

function fetchConnectionStatus(proxyUrl: URL): Promise<ConnectionStatus> {
  return new Promise((resolve) => {
    const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
    const request = https.get(IP_CHECK_URL, {
      agent,
      headers: {
        Accept: "application/json",
        "User-Agent": "Memoroom-Proxy-Health/1.0",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length < 64_000) body += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          resolve({
            ok: false,
            ip: null,
            country: null,
            organization: null,
            error: `실제 프록시 접속 응답 오류 (${response.statusCode || 0})`,
          });
          return;
        }

        try {
          const data = JSON.parse(body) as { ip?: string; country?: string; org?: string };
          resolve({
            ok: Boolean(data.ip),
            ip: safeString(data.ip),
            country: safeString(data.country),
            organization: safeString(data.org),
            error: data.ip ? null : "실제 접속 IP를 확인하지 못했습니다.",
          });
        } catch {
          resolve({
            ok: false,
            ip: null,
            country: null,
            organization: null,
            error: "실제 프록시 접속 결과를 해석하지 못했습니다.",
          });
        }
      });
    });

    request.setTimeout(15_000, () => request.destroy(new Error("실제 프록시 접속 시간이 초과되었습니다.")));
    request.on("error", (error) => {
      resolve({
        ok: false,
        ip: null,
        country: null,
        organization: null,
        error: /timeout|시간.*초과/i.test(error.message)
          ? "실제 프록시 접속 시간이 초과되었습니다."
          : "실제 프록시 접속에 실패했습니다.",
      });
    });
  });
}

function determineHealth(
  endpointConfigured: boolean,
  apiConfigured: boolean,
  management: ManagementStatus,
  connection: ConnectionStatus,
  expectedIp: string,
) {
  if (!endpointConfigured) {
    return { severity: "NOT_CONFIGURED" as ProxyHealthSeverity, summary: "ISP 프록시 미설정" };
  }
  if (!connection.ok) {
    return { severity: "ERROR" as ProxyHealthSeverity, summary: "프록시 연결 오류" };
  }
  if (normalizeCountry(connection.country) !== "KR") {
    return { severity: "ERROR" as ProxyHealthSeverity, summary: "한국 IP 확인 필요" };
  }
  if (expectedIp && connection.ip && expectedIp !== connection.ip) {
    return { severity: "ERROR" as ProxyHealthSeverity, summary: "고정 IP 불일치" };
  }
  if (!apiConfigured || !management.ok) {
    return { severity: "WARNING" as ProxyHealthSeverity, summary: "주문 상태 확인 필요" };
  }
  if (management.daysRemaining !== null && management.daysRemaining < 0) {
    return { severity: "ERROR" as ProxyHealthSeverity, summary: "ISP 프록시 만료" };
  }
  if (management.daysRemaining !== null && management.daysRemaining <= 3) {
    return { severity: "WARNING" as ProxyHealthSeverity, summary: "ISP 프록시 만료 임박" };
  }
  return { severity: "OK" as ProxyHealthSeverity, summary: "ISP 프록시 정상" };
}

async function inspectProxySellerStatus(): Promise<IspProxyStatus> {
  const apiKey = readEnv("PROXYSELLER_API_KEY");
  const host = readEnv("RPA_PROXY_HOST", "IPROYAL_PROXY_HOST");
  const port = readEnv("RPA_PROXY_PORT", "IPROYAL_PROXY_PORT");
  const protocol = readEnv("RPA_PROXY_PROTOCOL", "IPROYAL_PROXY_PROTOCOL") || "http";
  const username = readEnv("RPA_PROXY_USER", "RPA_PROXY_USERNAME", "IPROYAL_PROXY_USER");
  const password = readEnv("RPA_PROXY_PASS", "RPA_PROXY_PASSWORD", "IPROYAL_PROXY_PASS");
  const expectedIp = host && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : "";
  const endpointConfigured = Boolean(host && port && username && password);
  const apiConfigured = Boolean(apiKey);

  if (!endpointConfigured) {
    const checkedAt = new Date().toISOString();
    return {
      provider: "Proxy-Seller",
      configured: false,
      apiConfigured,
      endpointConfigured: false,
      apiOk: false,
      connectionOk: false,
      severity: "NOT_CONFIGURED",
      summary: "ISP 프록시 미설정",
      orderStatus: null,
      country: null,
      expiresOn: null,
      daysRemaining: null,
      autoRenew: null,
      autoRenewPeriod: null,
      expectedIp: maskIp(expectedIp || null),
      detectedIp: null,
      ipMatches: null,
      detectedCountry: null,
      detectedOrganization: null,
      checkedAt,
      error: "RPA 프록시 주소 또는 인증정보가 설정되지 않았습니다.",
    };
  }

  const proxyUrl = new URL(`${protocol}://${host}:${port}`);
  proxyUrl.username = username;
  proxyUrl.password = password;

  const [management, connection] = await Promise.all([
    fetchManagementStatus(apiKey, expectedIp),
    fetchConnectionStatus(proxyUrl),
  ]);
  const health = determineHealth(endpointConfigured, apiConfigured, management, connection, expectedIp);
  const ipMatches = expectedIp && connection.ip ? expectedIp === connection.ip : null;
  const errors = [management.error, connection.error].filter(Boolean);

  return {
    provider: "Proxy-Seller",
    configured: endpointConfigured && apiConfigured,
    apiConfigured,
    endpointConfigured,
    apiOk: management.ok,
    connectionOk: connection.ok,
    severity: health.severity,
    summary: health.summary,
    orderStatus: management.status,
    country: normalizeCountry(management.country),
    expiresOn: management.expiresOn,
    daysRemaining: management.daysRemaining,
    autoRenew: management.autoRenew,
    autoRenewPeriod: management.autoRenewPeriod,
    expectedIp: maskIp(management.ip || expectedIp || null),
    detectedIp: maskIp(connection.ip),
    ipMatches,
    detectedCountry: normalizeCountry(connection.country),
    detectedOrganization: connection.organization,
    checkedAt: new Date().toISOString(),
    error: errors.length > 0 ? errors.join(" / ") : null,
  };
}

export async function getProxySellerStatus(options: { force?: boolean } = {}) {
  const now = Date.now();
  if (!options.force && cachedStatus && cachedStatus.expiresAt > now) return cachedStatus.value;
  if (!options.force && inFlight) return inFlight;

  inFlight = inspectProxySellerStatus();
  try {
    const value = await inFlight;
    cachedStatus = { value, expiresAt: Date.now() + CACHE_MS };
    return value;
  } finally {
    inFlight = null;
  }
}

export async function checkProxySellerStatusAndAlert() {
  let status = await getProxySellerStatus({ force: true });

  if (shouldConfirmProxyConnectionFailure(status)) {
    for (const delayMs of PROXY_CONNECTION_CONFIRM_DELAYS_MS) {
      console.warn(
        `[Proxy] Connection check failed (${status.error || status.summary}); confirming again in ${delayMs / 1_000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      status = await getProxySellerStatus({ force: true });
      if (!shouldConfirmProxyConnectionFailure(status)) break;
    }
  }

  if (status.severity === "OK") {
    await resolveAdminAlertsByType(ALERT_TYPE);
    return status;
  }

  await createAdminAlert({
    type: ALERT_TYPE,
    severity: status.severity === "WARNING" ? "WARNING" : "CRITICAL",
    title: status.summary,
    message: status.error || (
      status.daysRemaining === null
        ? "설정의 RPA 탭에서 ISP 프록시 상태를 확인해 주세요."
        : `ISP 프록시가 ${status.daysRemaining}일 후 만료됩니다.`
    ),
    dedupeKey: `isp-proxy-${status.severity.toLowerCase()}`,
    repeatAfterMs: status.severity === "ERROR" || status.severity === "NOT_CONFIGURED"
      ? PROXY_OUTAGE_ALERT_REPEAT_MS
      : undefined,
  });

  return status;
}
