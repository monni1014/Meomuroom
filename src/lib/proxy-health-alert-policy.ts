import type { IspProxyStatus } from "./proxy-status-types";

export const PROXY_CONNECTION_CONFIRM_DELAYS_MS = [3_000, 7_000] as const;
export const PROXY_OUTAGE_ALERT_REPEAT_MS = 15 * 60 * 1000;

export function shouldConfirmProxyConnectionFailure(
  status: Pick<IspProxyStatus, "endpointConfigured" | "connectionOk" | "severity">,
) {
  return status.endpointConfigured && !status.connectionOk && status.severity === "ERROR";
}
