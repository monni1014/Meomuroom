export type ProxyHealthSeverity = "OK" | "WARNING" | "ERROR" | "NOT_CONFIGURED";

export type IspProxyStatus = {
  provider: "Proxy-Seller";
  configured: boolean;
  apiConfigured: boolean;
  endpointConfigured: boolean;
  apiOk: boolean;
  connectionOk: boolean;
  severity: ProxyHealthSeverity;
  summary: string;
  orderStatus: string | null;
  country: string | null;
  expiresOn: string | null;
  daysRemaining: number | null;
  autoRenew: boolean | null;
  autoRenewPeriod: string | null;
  expectedIp: string | null;
  detectedIp: string | null;
  ipMatches: boolean | null;
  detectedCountry: string | null;
  detectedOrganization: string | null;
  checkedAt: string;
  error: string | null;
};
