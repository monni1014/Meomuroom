#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const THRESHOLD_PERCENT = numberEnv("MEMOROOM_MEMORY_AUTO_THRESHOLD_PERCENT", 75);
const HOLD_SECONDS = numberEnv("MEMOROOM_MEMORY_AUTO_HOLD_SECONDS", 10 * 60);
const COOLDOWN_SECONDS = numberEnv("MEMOROOM_MEMORY_AUTO_COOLDOWN_SECONDS", 6 * 60 * 60);
const PENDING_STALE_SECONDS = numberEnv("MEMOROOM_MEMORY_AUTO_PENDING_STALE_SECONDS", 15 * 60);
const MEMINFO_PATH = process.env.MEMOROOM_MEMORY_AUTO_MEMINFO_PATH || "/proc/meminfo";
const STATE_PATH = process.env.MEMOROOM_MEMORY_AUTO_STATE_PATH
  || "/srv/memoroom/shared/memory-optimization-auto-state.json";
const REQUEST_PATH = process.env.MEMOROOM_MEMORY_OPTIMIZATION_REQUEST_PATH
  || "/srv/memoroom/shared/memory-optimization.request";
const RESULT_PATH = process.env.MEMOROOM_MEMORY_OPTIMIZATION_RESULT_PATH
  || "/srv/memoroom/shared/memory-optimization-result.json";
const MAINTENANCE_LOCK_PATH = process.env.MEMOROOM_RPA_MAINTENANCE_LOCK_PATH
  || "/srv/memoroom/shared/rpa-maintenance.lock";
const READINESS_URL = process.env.MEMOROOM_RPA_IDLE_URL
  || "http://127.0.0.1:3000/api/internal/rpa-idle";

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nowEpoch() {
  const override = Number(process.env.MEMOROOM_MEMORY_AUTO_NOW_EPOCH);
  return Number.isFinite(override) && override > 0
    ? Math.floor(override)
    : Math.floor(Date.now() / 1000);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, payload, mode = 0o644) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode });
  await rename(temporaryPath, path);
}

async function readMemory() {
  const text = await readFile(MEMINFO_PATH, "utf8");
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal") || 0;
  const availableBytes = values.get("MemAvailable") || 0;
  if (totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) {
    throw new Error("Unable to read valid Linux memory information.");
  }
  const usedBytes = totalBytes - availableBytes;
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}

async function readinessIsIdle() {
  try {
    const response = await fetch(READINESS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    return (await response.json())?.idle === true;
  } catch {
    return false;
  }
}

function statePayload(state, now, memory, status, extra = {}) {
  return {
    version: 1,
    thresholdPercent: THRESHOLD_PERCENT,
    holdSeconds: HOLD_SECONDS,
    cooldownSeconds: COOLDOWN_SECONDS,
    aboveThresholdSince: state.aboveThresholdSince ?? null,
    lastTriggeredAt: state.lastTriggeredAt ?? null,
    pendingRequestId: state.pendingRequestId ?? null,
    pendingRequestedAt: state.pendingRequestedAt ?? null,
    pendingThresholdSince: state.pendingThresholdSince ?? null,
    lastObservedPercent: memory.usedPercent,
    status,
    updatedAt: new Date(now * 1000).toISOString(),
    ...extra,
  };
}

async function main() {
  const now = nowEpoch();
  const memory = await readMemory();
  const state = await readJson(STATE_PATH, {}) || {};

  if (state.pendingRequestId) {
    const result = await readJson(RESULT_PATH);
    if (result?.requestId === state.pendingRequestId && ["COMPLETED", "FAILED", "CANCELLED"].includes(result.status)) {
      const wasCancelled = result.status === "CANCELLED";
      state.pendingRequestId = null;
      state.pendingRequestedAt = null;
      state.lastResultStatus = result.status;
      state.lastResultAt = now;
      if (wasCancelled) {
        state.lastTriggeredAt = null;
        state.aboveThresholdSince = state.pendingThresholdSince ?? now - HOLD_SECONDS;
      }
      state.pendingThresholdSince = null;
      if (result.status === "COMPLETED") state.aboveThresholdSince = null;
    } else {
      const pendingAge = now - Number(state.pendingRequestedAt || now);
      if (await exists(REQUEST_PATH) || await exists(MAINTENANCE_LOCK_PATH) || pendingAge < PENDING_STALE_SECONDS) {
        await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "REQUEST_ACTIVE"));
        return;
      }
      state.pendingRequestId = null;
      state.pendingRequestedAt = null;
      state.pendingThresholdSince = null;
      state.lastResultStatus = "STALE";
      state.lastResultAt = now;
    }
  }

  if (memory.usedPercent < THRESHOLD_PERCENT) {
    state.aboveThresholdSince = null;
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "BELOW_THRESHOLD"));
    return;
  }

  if (state.aboveThresholdSince == null || !Number.isFinite(Number(state.aboveThresholdSince))) {
    state.aboveThresholdSince = now;
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "TRACKING"));
    return;
  }

  const highForSeconds = Math.max(0, now - Number(state.aboveThresholdSince));
  if (highForSeconds < HOLD_SECONDS) {
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "TRACKING", { highForSeconds }));
    return;
  }

  const lastTriggeredAt = Number(state.lastTriggeredAt || 0);
  const cooldownRemainingSeconds = Math.max(0, COOLDOWN_SECONDS - (now - lastTriggeredAt));
  if (lastTriggeredAt > 0 && cooldownRemainingSeconds > 0) {
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "COOLDOWN", { cooldownRemainingSeconds }));
    return;
  }

  if (await exists(REQUEST_PATH) || await exists(MAINTENANCE_LOCK_PATH)) {
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "REQUEST_ACTIVE", { highForSeconds }));
    return;
  }

  if (!await readinessIsIdle()) {
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, memory, "WAITING_FOR_RPA", { highForSeconds }));
    return;
  }

  const finalMemory = await readMemory();
  if (finalMemory.usedPercent < THRESHOLD_PERCENT) {
    state.aboveThresholdSince = null;
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, finalMemory, "BELOW_THRESHOLD"));
    return;
  }

  const requestId = `auto-${randomUUID()}`;
  const temporaryRequestPath = `${REQUEST_PATH}.${requestId}.tmp`;
  await writeFile(temporaryRequestPath, `${requestId}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await link(temporaryRequestPath, REQUEST_PATH);
  } catch (error) {
    await unlink(temporaryRequestPath).catch(() => undefined);
    if (error?.code !== "EEXIST") throw error;
    await writeJsonAtomic(STATE_PATH, statePayload(state, now, finalMemory, "REQUEST_ACTIVE", { highForSeconds }));
    return;
  }
  await unlink(temporaryRequestPath);

  state.lastTriggeredAt = now;
  state.pendingRequestId = requestId;
  state.pendingRequestedAt = now;
  state.pendingThresholdSince = state.aboveThresholdSince;
  state.aboveThresholdSince = null;
  await writeJsonAtomic(STATE_PATH, statePayload(state, now, finalMemory, "TRIGGERED", {
    trigger: "AUTO_HIGH_MEMORY",
    requestId,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
