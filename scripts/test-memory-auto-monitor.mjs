#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "memoroom-memory-auto-"));
const script = resolve("ops/scripts/memoroom-memory-auto-monitor.mjs");
const statePath = join(root, "state.json");
const requestPath = join(root, "request");
const resultPath = join(root, "result.json");
const lockPath = join(root, "lock");
const meminfoPath = join(root, "meminfo");

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"idle":true}');
});
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
assert(address && typeof address === "object");

const baseEnv = {
  ...process.env,
  MEMOROOM_MEMORY_AUTO_THRESHOLD_PERCENT: "75",
  MEMOROOM_MEMORY_AUTO_HOLD_SECONDS: "600",
  MEMOROOM_MEMORY_AUTO_COOLDOWN_SECONDS: "21600",
  MEMOROOM_MEMORY_AUTO_MEMINFO_PATH: meminfoPath,
  MEMOROOM_MEMORY_AUTO_STATE_PATH: statePath,
  MEMOROOM_MEMORY_OPTIMIZATION_REQUEST_PATH: requestPath,
  MEMOROOM_MEMORY_OPTIMIZATION_RESULT_PATH: resultPath,
  MEMOROOM_RPA_MAINTENANCE_LOCK_PATH: lockPath,
  MEMOROOM_RPA_IDLE_URL: `http://127.0.0.1:${address.port}`,
};

async function run(now, extraEnv = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script], {
      env: { ...baseEnv, MEMOROOM_MEMORY_AUTO_NOW_EPOCH: String(now), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`monitor exited ${code}: ${stderr}`)));
  });
  return JSON.parse(await readFile(statePath, "utf8"));
}

try {
  await writeFile(meminfoPath, "MemTotal:       100000 kB\nMemAvailable:    20000 kB\n");

  let state = await run(1_000);
  assert.equal(state.status, "TRACKING");
  assert.equal(state.aboveThresholdSince, 1_000);

  state = await run(1_599);
  assert.equal(state.status, "TRACKING");
  assert.equal(state.highForSeconds, 599);

  state = await run(1_600);
  assert.equal(state.status, "TRIGGERED");
  assert.match((await readFile(requestPath, "utf8")).trim(), /^auto-/);
  const firstRequestId = state.pendingRequestId;

  await unlink(requestPath);
  await writeFile(resultPath, `${JSON.stringify({ requestId: firstRequestId, status: "COMPLETED" })}\n`);
  state = await run(1_601);
  assert.equal(state.status, "TRACKING");

  state = await run(2_201);
  assert.equal(state.status, "COOLDOWN");

  await writeFile(meminfoPath, "MemTotal:       100000 kB\nMemAvailable:    30000 kB\n");
  state = await run(2_202);
  assert.equal(state.status, "BELOW_THRESHOLD");
  assert.equal(state.aboveThresholdSince, null);

  await writeFile(meminfoPath, "MemTotal:       100000 kB\nMemAvailable:    20000 kB\n");
  await writeFile(statePath, `${JSON.stringify({ aboveThresholdSince: 30_000 })}\n`);
  state = await run(30_600, { MEMOROOM_RPA_IDLE_URL: "http://127.0.0.1:1" });
  assert.equal(state.status, "WAITING_FOR_RPA");

  console.log("memory auto monitor policy tests passed");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
