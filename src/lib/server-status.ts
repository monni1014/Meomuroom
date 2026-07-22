import "server-only";

import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
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
    return {
      status: "ACTIVE" as const,
      detail: "SQLite 읽기 정상",
      responseMs: Date.now() - startedAt,
    };
  } catch {
    return {
      status: "INACTIVE" as const,
      detail: "SQLite 응답 없음",
      responseMs: Date.now() - startedAt,
    };
  }
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
  const [appState, tailscaleState, tailscaleIpOutput, database, memory, disk] = await Promise.all([
    commandOutput("/usr/bin/systemctl", ["is-active", "memoroom-app.service"]),
    commandOutput("/usr/bin/systemctl", ["is-active", "tailscaled.service"]),
    commandOutput("/usr/bin/tailscale", ["ip", "-4"]),
    databaseStatus(),
    memoryStatus(),
    diskStatus(),
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
    warnings,
  };
}
