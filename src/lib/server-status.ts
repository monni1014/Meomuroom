import "server-only";

import { execFile } from "node:child_process";
import { readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import type {
  ServerOverallStatus,
  ServerServiceStatus,
  ServerStatusSnapshot,
} from "@/lib/server-status-types";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 2_500;
const DATABASE_TIMEOUT_MS = 5_000;
const SERVER_METRICS_FILE = process.env.MEMOROOM_SERVER_METRICS_FILE
  || "/srv/memoroom/shared/server-memory-metrics.json";
const VULTR_PLAN_ID = process.env.VULTR_PLAN_ID || "vc2-2c-4gb";
const VULTR_STARTED_AT = process.env.VULTR_STARTED_AT || "2026-07-18T17:36:40.000Z";
const VULTR_HOURLY_COST_USD = Number(process.env.VULTR_HOURLY_COST_USD || "0.027");
const VULTR_MONTHLY_COST_USD = Number(process.env.VULTR_MONTHLY_COST_USD || "20");

function round(value: number, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percent(used: number, total: number) {
  if (total <= 0) return 0;
  return round((used / total) * 100);
}

async function commandOutput(file: string, args: string[]) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout.trim() || null;
  } catch (error) {
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String(error.stdout || "").trim()
      : "";
    return stdout || null;
  }
}

function serviceStatus(value: string | null): ServerServiceStatus {
  if (value === "active") return { status: "ACTIVE", detail: "정상 실행 중" };
  if (value) return { status: "INACTIVE", detail: value };
  return { status: "UNKNOWN", detail: "상태를 확인하지 못했습니다." };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function databaseStatus() {
  const startedAt = Date.now();
  try {
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1 AS ok"), DATABASE_TIMEOUT_MS);
    const sizeBytes = await stat(`${process.cwd()}/dev.db`).then((entry) => entry.size).catch(() => null);
    return {
      status: "ACTIVE" as const,
      detail: "SQLite 읽기 정상",
      responseMs: Date.now() - startedAt,
      sizeBytes,
    };
  } catch {
    return {
      status: "INACTIVE" as const,
      detail: "SQLite 응답 없음",
      responseMs: Date.now() - startedAt,
      sizeBytes: null,
    };
  }
}

type StoredMemoryMetrics = {
  monitoringSince?: unknown;
  lastSampledAt?: unknown;
  sampleCount?: unknown;
  systemPeakUsedBytes?: unknown;
  systemPeakUsedPercent?: unknown;
  appPeakBytes?: unknown;
  appPeakPercent?: unknown;
};

function storedNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function observedMemoryPeak(): Promise<ServerStatusSnapshot["memory"]["observedPeak"]> {
  try {
    const parsed = JSON.parse(await readFile(SERVER_METRICS_FILE, "utf8")) as StoredMemoryMetrics;
    if (typeof parsed.monitoringSince !== "string" || typeof parsed.lastSampledAt !== "string") return null;
    return {
      monitoringSince: parsed.monitoringSince,
      lastSampledAt: parsed.lastSampledAt,
      sampleCount: storedNumber(parsed.sampleCount),
      systemUsedBytes: storedNumber(parsed.systemPeakUsedBytes),
      systemUsedPercent: storedNumber(parsed.systemPeakUsedPercent),
      appBytes: storedNumber(parsed.appPeakBytes),
      appPercent: storedNumber(parsed.appPeakPercent),
    };
  } catch {
    return null;
  }
}

function estimateCostBetween(startedAt: Date, endedAt: Date) {
  if (endedAt <= startedAt) return 0;
  let cursor = new Date(startedAt);
  let total = 0;
  while (cursor < endedAt) {
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const segmentEnd = nextMonth < endedAt ? nextMonth : endedAt;
    const hours = Math.ceil((segmentEnd.getTime() - cursor.getTime()) / 3_600_000);
    total += Math.min(VULTR_MONTHLY_COST_USD, hours * VULTR_HOURLY_COST_USD);
    cursor = segmentEnd;
  }
  return round(total, 2);
}

function billingStatus(): ServerStatusSnapshot["billing"] {
  const now = new Date();
  const startedAt = new Date(VULTR_STARTED_AT);
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    provider: "Vultr",
    planId: VULTR_PLAN_ID,
    startedAt: startedAt.toISOString(),
    hourlyCostUsd: VULTR_HOURLY_COST_USD,
    monthlyCostUsd: VULTR_MONTHLY_COST_USD,
    currentMonthEstimatedUsd: estimateCostBetween(startedAt > currentMonthStart ? startedAt : currentMonthStart, now),
    lifetimeEstimatedUsd: estimateCostBetween(startedAt, now),
    estimate: true,
  };
}

function parseLinuxMemory(content: string) {
  const values = new Map<string, number>();
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }

  const totalBytes = values.get("MemTotal") || os.totalmem();
  const availableBytes = values.get("MemAvailable") || os.freemem();
  const swapTotalBytes = values.get("SwapTotal") || 0;
  const swapFreeBytes = values.get("SwapFree") || 0;
  return {
    totalBytes,
    availableBytes,
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
  };
}

async function memoryStatus() {
  try {
    return parseLinuxMemory(await readFile("/proc/meminfo", "utf8"));
  } catch {
    return {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    };
  }
}

function processGroup(command: string) {
  const normalized = command.toLowerCase();
  if (normalized.includes("chrome") || normalized.includes("chromium")) {
    return { key: "rpa-browser", label: "RPA 브라우저" };
  }
  if (normalized.includes("xvfb")) return { key: "rpa-screen", label: "스클 가상 화면" };
  if (normalized.includes("next-server")) return { key: "memoroom-app", label: "머무룸 웹·자동화" };
  if (normalized === "npm start" || normalized === "npm") {
    return { key: "memoroom-runner", label: "머무룸 실행 관리자" };
  }
  if (normalized === "node") return { key: "node-worker", label: "예약·백업 작업" };
  if (normalized.includes("tailscale")) return { key: "tailscale", label: "Tailscale 보안 연결" };
  if (normalized.includes("systemd-journal")) return { key: "system-log", label: "서버 시스템 로그" };
  if (normalized.includes("sshd")) return { key: "ssh", label: "서버 원격 관리" };
  if (normalized.includes("systemd")) return { key: "systemd", label: "리눅스 시스템" };
  return { key: normalized || "other", label: command || "기타 작업" };
}

async function processMemoryStatus(): Promise<ServerStatusSnapshot["memory"]["processes"]> {
  const output = await commandOutput("/usr/bin/ps", ["-eo", "pid=,rss=,pmem=,comm="]);
  if (!output) return [];

  const grouped = new Map<string, ServerStatusSnapshot["memory"]["processes"][number]>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!match) continue;
    const rssBytes = Number(match[2]) * 1024;
    if (!Number.isFinite(rssBytes) || rssBytes <= 0) continue;
    const group = processGroup(match[4].trim());
    const existing = grouped.get(group.key);
    if (existing) {
      existing.processCount += 1;
      existing.rssBytes += rssBytes;
      existing.usedPercent = round(existing.usedPercent + Number(match[3] || 0));
    } else {
      grouped.set(group.key, {
        ...group,
        processCount: 1,
        rssBytes,
        usedPercent: round(Number(match[3] || 0)),
      });
    }
  }

  return [...grouped.values()]
    .sort((left, right) => right.rssBytes - left.rssBytes)
    .slice(0, 12);
}

async function diskStatus(): Promise<ServerStatusSnapshot["disk"]> {
  try {
    const disk = await statfs(process.cwd());
    const totalBytes = disk.blocks * disk.bsize;
    const availableBytes = disk.bavail * disk.bsize;
    const freeBytes = disk.bfree * disk.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: percent(usedBytes, totalBytes),
    };
  } catch {
    return null;
  }
}

export async function getServerStatus(): Promise<ServerStatusSnapshot> {
  const [appState, tailscaleState, tailscaleIpOutput, database, memory, disk, observedPeak, processes] = await Promise.all([
    commandOutput("/usr/bin/systemctl", ["is-active", "memoroom-app.service"]),
    commandOutput("/usr/bin/systemctl", ["is-active", "tailscaled.service"]),
    commandOutput("/usr/bin/tailscale", ["ip", "-4"]),
    databaseStatus(),
    memoryStatus(),
    diskStatus(),
    observedMemoryPeak(),
    processMemoryStatus(),
  ]);

  const processMemory = process.memoryUsage();
  const usedMemoryBytes = Math.max(0, memory.totalBytes - memory.availableBytes);
  const usedMemoryPercent = percent(usedMemoryBytes, memory.totalBytes);
  const [load1, load5, load15] = os.loadavg();
  const cores = Math.max(1, os.cpus().length);
  const loadPerCorePercent = round((load1 / cores) * 100);
  const app = serviceStatus(appState);
  const tailscale = serviceStatus(tailscaleState);
  const warnings: string[] = [];

  if (app.status !== "ACTIVE") warnings.push("머무룸 앱 서비스 상태를 확인해야 합니다.");
  if (database.status !== "ACTIVE") warnings.push("SQLite 데이터베이스가 응답하지 않습니다.");
  if (tailscale.status !== "ACTIVE") warnings.push("Tailscale 서비스 상태를 확인해야 합니다.");
  if (usedMemoryPercent >= 85) warnings.push(`RAM 사용률이 ${usedMemoryPercent}%입니다.`);
  if (disk && disk.usedPercent >= 85) warnings.push(`SSD 사용률이 ${disk.usedPercent}%입니다.`);
  if (loadPerCorePercent >= 100) warnings.push(`CPU 1분 부하가 코어 기준 ${loadPerCorePercent}%입니다.`);
  if (!disk) warnings.push("SSD 사용량을 확인하지 못했습니다.");

  let overallStatus: ServerOverallStatus = "OK";
  if (app.status !== "ACTIVE" || database.status !== "ACTIVE" || tailscale.status !== "ACTIVE") {
    overallStatus = "ERROR";
  } else if (warnings.length > 0) {
    overallStatus = "WARNING";
  }

  const summary = overallStatus === "OK"
    ? "정상 작동 중"
    : overallStatus === "WARNING"
      ? "점검 권장"
      : "확인 필요";

  return {
    overallStatus,
    summary,
    checkedAt: new Date().toISOString(),
    hostname: os.hostname(),
    services: {
      app,
      database,
      tailscale: {
        ...tailscale,
        ip: tailscaleIpOutput?.split(/\s+/)[0] || null,
      },
    },
    memory: {
      totalBytes: memory.totalBytes,
      usedBytes: usedMemoryBytes,
      availableBytes: memory.availableBytes,
      usedPercent: usedMemoryPercent,
      appRssBytes: processMemory.rss,
      appHeapUsedBytes: processMemory.heapUsed,
      swapTotalBytes: memory.swapTotalBytes,
      swapUsedBytes: memory.swapUsedBytes,
      processes,
      observedPeak,
    },
    disk,
    cpu: {
      cores,
      load1: round(load1, 2),
      load5: round(load5, 2),
      load15: round(load15, 2),
      loadPerCorePercent,
    },
    uptime: {
      systemSeconds: Math.floor(os.uptime()),
      appSeconds: Math.floor(process.uptime()),
    },
    billing: billingStatus(),
    warnings,
  };
}
