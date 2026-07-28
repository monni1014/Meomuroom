import "server-only";

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IspProxyStatus } from "./proxy-status-types";
import {
  resolveRpaProxyCircuitMode,
  rpaProxyIsRequired,
  type RpaProxyCircuitMode,
} from "./rpa-proxy-circuit-policy";

export type RpaProxyCircuitState = {
  mode: RpaProxyCircuitMode;
  proxyRequired: boolean;
  reason: string;
  checkedAt: string | null;
  updatedAt: string;
};

export type RpaProxyCircuitTransition = "NONE" | "PAUSED" | "RESUMED";

type CircuitGlobal = typeof globalThis & {
  __memoroomRpaProxyCircuit?: RpaProxyCircuitState;
};

const DEFAULT_STATE_PATH = join(process.cwd(), "rpa", ".runtime", "proxy-circuit.json");

function statePath() {
  const configured = process.env.RPA_PROXY_CIRCUIT_STATE_PATH?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ configured) : DEFAULT_STATE_PATH;
}

function initialState(): RpaProxyCircuitState {
  const proxyRequired = rpaProxyIsRequired();
  return {
    mode: proxyRequired ? "CHECKING" : "READY",
    proxyRequired,
    reason: proxyRequired ? "프록시 상태 확인 전" : "프록시 강제 사용 안 함",
    checkedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function persistState(state: RpaProxyCircuitState) {
  const path = statePath();
  const tempPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(tempPath, path);
}

function setState(state: RpaProxyCircuitState) {
  const g = globalThis as CircuitGlobal;
  g.__memoroomRpaProxyCircuit = state;
  persistState(state);
  return state;
}

export function getRpaProxyCircuitState() {
  const g = globalThis as CircuitGlobal;
  g.__memoroomRpaProxyCircuit ??= initialState();
  return g.__memoroomRpaProxyCircuit;
}

export function initializeRpaProxyCircuitCheck() {
  const current = getRpaProxyCircuitState();
  if (!current.proxyRequired) {
    persistState(current);
    return current;
  }

  return setState({
    mode: "CHECKING",
    proxyRequired: true,
    reason: "프록시 상태 확인 중",
    checkedAt: current.checkedAt,
    updatedAt: new Date().toISOString(),
  });
}

export function updateRpaProxyCircuit(status: IspProxyStatus) {
  const previous = getRpaProxyCircuitState();
  const mode = resolveRpaProxyCircuitMode(status);
  const next = setState({
    mode,
    proxyRequired: rpaProxyIsRequired(),
    reason: status.error || status.summary,
    checkedAt: status.checkedAt,
    updatedAt: new Date().toISOString(),
  });

  const transition: RpaProxyCircuitTransition = mode === "PAUSED" && previous.mode !== "PAUSED"
    ? "PAUSED"
    : mode === "READY" && previous.mode !== "READY"
      ? "RESUMED"
      : "NONE";

  return { state: next, transition };
}

export function isRpaPausedForProxy() {
  const state = getRpaProxyCircuitState();
  return state.proxyRequired && state.mode !== "READY";
}
