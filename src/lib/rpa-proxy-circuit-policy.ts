import type { IspProxyStatus } from "./proxy-status-types";

export type RpaProxyCircuitMode = "CHECKING" | "PAUSED" | "READY";

export function rpaProxyIsRequired(env: NodeJS.ProcessEnv = process.env) {
  return env.RPA_USE_PROXY?.trim().toLowerCase() === "true"
    && env.RPA_PROXY_DIRECT_FALLBACK?.trim().toLowerCase() !== "true";
}

export function resolveRpaProxyCircuitMode(
  status: IspProxyStatus,
  env: NodeJS.ProcessEnv = process.env,
): RpaProxyCircuitMode {
  if (!rpaProxyIsRequired(env)) return "READY";

  if (
    !status.endpointConfigured
    || status.severity === "NOT_CONFIGURED"
    || status.severity === "ERROR"
  ) {
    return "PAUSED";
  }

  // 관리 API만 일시적으로 실패해도 실제 한국 프록시 접속이 확인됐다면
  // 예약 RPA는 안전하게 계속할 수 있다.
  return status.connectionOk ? "READY" : "PAUSED";
}

