import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but this account cannot signal it.
    if (error?.code === "EPERM") return true;
    return null;
  }
}

async function removeStaleLock(lockPath, staleMs) {
  try {
    const info = await stat(lockPath);
    const content = await readFile(lockPath, "utf8").catch(() => "");
    const pidMatch = /(?:^|\n)pid=(\d+)(?:\n|$)/.exec(content);
    const lockPid = pidMatch ? Number(pidMatch[1]) : null;
    const lockOwnerRunning = processIsRunning(lockPid);
    const oldEnough = Date.now() - info.mtimeMs >= staleMs;

    if (lockOwnerRunning !== false && !oldEnough) return false;

    console.log(`Remove stale RPA lock: ${lockPath}${content ? ` (${content.trim()})` : ""}`);
    await rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function acquireProcessLock(lockPath, {
  label = "RPA task",
  timeoutMs = 12 * 60 * 1000,
  staleMs = 15 * 60 * 1000,
  failIfLocked = false,
} = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await writeFile(handle, `${label}\npid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);
      await handle.close();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const removed = await removeStaleLock(lockPath, staleMs);

      if (failIfLocked && !removed) {
        throw new Error(`${label} is already running. Use the existing login window.`);
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`${label} lock timeout. Another RPA task is still running: ${lockPath}`);
      }

      const retryMin = Number(process.env.RPA_LOCK_RETRY_MIN_MS || "1200") || 1200;
      const retryMax = Number(process.env.RPA_LOCK_RETRY_MAX_MS || "2400") || 2400;
      console.log(`${label} lock exists. Wait before retry.`);
      await sleep(randomInt(retryMin, Math.max(retryMin, retryMax)));
    }
  }
}
