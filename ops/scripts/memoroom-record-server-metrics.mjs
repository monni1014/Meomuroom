#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_SERVICE = process.env.MEMOROOM_APP_SERVICE || "memoroom-app.service";
const METRICS_FILE = process.env.MEMOROOM_SERVER_METRICS_FILE
  || "/srv/memoroom/shared/server-memory-metrics.json";
const HISTORY_SINCE = process.env.MEMOROOM_SERVER_METRICS_SINCE || "2026-07-18";

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function parseMeminfo(content) {
  const values = new Map();
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal") || 0;
  const availableBytes = values.get("MemAvailable") || 0;
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes),
  };
}

function parseHumanBytes(value, unit) {
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit.toUpperCase()] || 1;
  return Math.round(Number(value) * multiplier);
}

async function readExisting() {
  try {
    const parsed = JSON.parse(await readFile(METRICS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readCgroupMetric(controlGroup, name) {
  try {
    const value = (await readFile(`/sys/fs/cgroup${controlGroup}/${name}`, "utf8")).trim();
    return value === "max" ? 0 : finiteNumber(value);
  } catch {
    return 0;
  }
}

async function historicalAppPeakBytes() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/journalctl", [
      "-u",
      APP_SERVICE,
      "--since",
      HISTORY_SINCE,
      "--grep",
      "memory peak",
      "--no-pager",
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });

    let peak = 0;
    for (const match of stdout.matchAll(/([0-9]+(?:\.[0-9]+)?)([KMGT])\s+memory peak/gi)) {
      peak = Math.max(peak, parseHumanBytes(match[1], match[2]));
    }
    return peak;
  } catch {
    return 0;
  }
}

async function main() {
  const sampledAt = new Date().toISOString();
  const memory = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  const { stdout } = await execFileAsync("/usr/bin/systemctl", [
    "show",
    APP_SERVICE,
    "-p",
    "ControlGroup",
    "--value",
  ], { encoding: "utf8", timeout: 5_000 });
  const controlGroup = stdout.trim();
  const [appCurrentBytes, appSessionPeakBytes, existing] = await Promise.all([
    readCgroupMetric(controlGroup, "memory.current"),
    readCgroupMetric(controlGroup, "memory.peak"),
    readExisting(),
  ]);
  const initialHistoricalPeak = finiteNumber(existing.sampleCount) > 0
    ? 0
    : await historicalAppPeakBytes();

  const appPeakBytes = Math.max(
    finiteNumber(existing.appPeakBytes),
    appCurrentBytes,
    appSessionPeakBytes,
    initialHistoricalPeak,
  );
  const systemPeakUsedBytes = Math.max(
    finiteNumber(existing.systemPeakUsedBytes),
    memory.usedBytes,
  );
  const next = {
    monitoringSince: typeof existing.monitoringSince === "string"
      ? existing.monitoringSince
      : sampledAt,
    lastSampledAt: sampledAt,
    sampleCount: finiteNumber(existing.sampleCount) + 1,
    totalBytes: memory.totalBytes,
    systemPeakUsedBytes,
    systemPeakUsedPercent: memory.totalBytes > 0
      ? Math.round((systemPeakUsedBytes / memory.totalBytes) * 1000) / 10
      : 0,
    appCurrentBytes,
    appSessionPeakBytes,
    appPeakBytes,
    appPeakPercent: memory.totalBytes > 0
      ? Math.round((appPeakBytes / memory.totalBytes) * 1000) / 10
      : 0,
  };

  await mkdir(dirname(METRICS_FILE), { recursive: true });
  const temporaryFile = `${METRICS_FILE}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await chmod(temporaryFile, 0o644);
  await rename(temporaryFile, METRICS_FILE);
}

await main();
