import { chromium } from "playwright";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "./lib/cli.mjs";
import { assertRpaExecutionAllowed, getProxyConfig } from "./lib/env.mjs";
import {
  installRpaResourceBlocking,
  shouldUseRpaProxy,
} from "./lib/browser.mjs";
import { shouldCloseRpaPage } from "./lib/popup-cleanup.mjs";
import {
  naverStorageStatePath,
  spaceCloudStorageStatePath,
} from "./lib/paths.mjs";

const runtimeDir = resolve("rpa/.runtime");
const statePath = resolve(runtimeDir, "browser-host.json");
const profileDir = resolve(runtimeDir, "chromium-profile");
const args = parseArgs(process.argv);
const headless = args.headless !== "false";
const popupCleanupIntervalMs = Math.max(
  15_000,
  Number(process.env.RPA_POPUP_CLEANUP_INTERVAL_MS) || 60_000,
);
const popupGraceMs = Math.max(
  30_000,
  Number(process.env.RPA_POPUP_CLEANUP_GRACE_MS) || 120_000,
);
const orphanGraceMs = Math.max(
  popupGraceMs,
  Number(process.env.RPA_ORPHAN_PAGE_CLEANUP_GRACE_MS) || 30 * 60_000,
);

assertRpaExecutionAllowed();

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => port ? resolvePort(port) : reject(new Error("Could not allocate CDP port")));
    });
  });
}

function storageVersion(path) {
  return existsSync(path) ? String(Math.trunc(statSync(path).mtimeMs)) : "none";
}

async function applyStorageState(context, path) {
  if (!existsSync(path)) return;
  const storage = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(storage.cookies) && storage.cookies.length > 0) {
    await context.addCookies(storage.cookies);
  }

  const origins = Object.fromEntries((storage.origins || []).map((origin) => [
    origin.origin,
    origin.localStorage || [],
  ]));
  if (Object.keys(origins).length > 0) {
    await context.addInitScript((savedOrigins) => {
      for (const entry of savedOrigins[location.origin] || []) {
        localStorage.setItem(entry.name, entry.value);
      }
    }, origins);
  }
}

async function assignPageRole(page, role) {
  await page.addInitScript((assignedRole) => {
    Object.defineProperty(window, "__MEMOROOM_RPA_PAGE_ROLE__", {
      configurable: true,
      value: assignedRole,
    });
  }, role);
  await page.evaluate((assignedRole) => {
    Object.defineProperty(window, "__MEMOROOM_RPA_PAGE_ROLE__", {
      configurable: true,
      value: assignedRole,
    });
  }, role);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function readPageRole(page) {
  return page.evaluate(() => window.__MEMOROOM_RPA_PAGE_ROLE__ || null).catch(() => null);
}

async function waitForCdp(endpoint, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error("Chromium CDP endpoint did not become ready within 20 seconds.");
}

const cdpPort = await freePort();
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
const proxyEnabled = await shouldUseRpaProxy({ useProxy: true, forceProxy: false });
const proxy = proxyEnabled ? getProxyConfig() : null;

const chromiumArgs = [
  `--remote-debugging-port=${cdpPort}`,
  "--no-sandbox",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disk-cache-size=33554432",
  "--media-cache-size=1",
  "--metrics-recording-only",
  "--no-first-run",
  "--lang=ko-KR",
  "--window-size=1440,1000",
];
const context = await chromium.launchPersistentContext(profileDir, {
  headless,
  viewport: { width: 1440, height: 1000 },
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
  serviceWorkers: "block",
  args: chromiumArgs,
  ...(proxy ? {
    proxy: {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    },
  } : {}),
});

await waitForCdp(cdpEndpoint);
const browser = context.browser();
if (!browser) throw new Error("Chromium persistent browser was not available.");

await context.setExtraHTTPHeaders({ "Save-Data": "on" });
await installRpaResourceBlocking(context);
await applyStorageState(context, naverStorageStatePath);
await applyStorageState(context, spaceCloudStorageStatePath);

const initialPages = context.pages();
const naverPage = initialPages[0] || await context.newPage();
await assignPageRole(naverPage, "naver");
const spaceCloudPage = await context.newPage();
await assignPageRole(spaceCloudPage, "spacecloud");

const fixedPages = new Set([naverPage, spaceCloudPage]);
const pageMetadata = new Map();

function trackPage(page) {
  if (pageMetadata.has(page)) return;

  const metadata = {
    openedAt: Date.now(),
    hadOpener: false,
  };
  pageMetadata.set(page, metadata);
  page.once("close", () => pageMetadata.delete(page));

  void page.opener()
    .then((opener) => {
      metadata.hadOpener = Boolean(opener);
    })
    .catch(() => {});
}

for (const page of context.pages()) trackPage(page);
context.on("page", trackPage);

let popupCleanupRunning = false;
async function cleanupUnexpectedPages() {
  if (popupCleanupRunning) return;
  popupCleanupRunning = true;

  try {
    const now = Date.now();
    for (const page of context.pages()) {
      if (page.isClosed() || fixedPages.has(page)) continue;

      const metadata = pageMetadata.get(page);
      if (!metadata) continue;

      const role = await readPageRole(page);
      const url = page.url();
      if (!shouldCloseRpaPage({
        ageMs: now - metadata.openedAt,
        hadOpener: metadata.hadOpener,
        role,
        url,
        popupGraceMs,
        orphanGraceMs,
      })) continue;

      await page.close({ runBeforeUnload: false }).catch(() => {});
      console.warn(`[RPA browser] Closed an unexpected stale page: ${url.slice(0, 200)}`);
    }
  } finally {
    popupCleanupRunning = false;
  }
}

const popupCleanupTimer = setInterval(() => {
  void cleanupUnexpectedPages().catch((error) => {
    console.error(`[RPA browser] Popup cleanup failed: ${error instanceof Error ? error.message : error}`);
  });
}, popupCleanupIntervalMs);
popupCleanupTimer.unref();

let authVersions = {
  naver: storageVersion(naverStorageStatePath),
  spacecloud: storageVersion(spaceCloudStorageStatePath),
};

const authTimer = setInterval(async () => {
  const nextVersions = {
    naver: storageVersion(naverStorageStatePath),
    spacecloud: storageVersion(spaceCloudStorageStatePath),
  };
  if (nextVersions.naver !== authVersions.naver) {
    await applyStorageState(context, naverStorageStatePath).catch(console.error);
  }
  if (nextVersions.spacecloud !== authVersions.spacecloud) {
    await applyStorageState(context, spaceCloudStorageStatePath).catch(console.error);
  }
  authVersions = nextVersions;
}, 2_000);
authTimer.unref();

writeFileSync(statePath, JSON.stringify({
  cdpEndpoint,
  pid: process.pid,
  headless,
  networkMode: proxyEnabled ? "proxy" : "direct",
  startedAt: new Date().toISOString(),
}, null, 2));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(authTimer);
  clearInterval(popupCleanupTimer);
  rmSync(statePath, { force: true });
  await context.close().catch(() => {});
}

browser.once("disconnected", () => {
  if (!shuttingDown) process.exit(1);
});
process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.once("exit", () => rmSync(statePath, { force: true }));

await new Promise(() => {});
