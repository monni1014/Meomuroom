import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  naverStorageStatePath,
  spaceCloudStorageStatePath,
} from "../rpa/lib/paths.mjs";
import { sharedBrowserRuntimePaths } from "../rpa/lib/browser.mjs";

const AUTH_COOKIE_NAMES = {
  naver: ["NID_SES"],
  spacecloud: ["refresh_token"],
};

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findExpiry(cookies, platform) {
  const names = AUTH_COOKIE_NAMES[platform];
  const candidates = (cookies || [])
    .filter((cookie) => names.includes(cookie.name) && Number(cookie.expires) > 0)
    .map((cookie) => ({
      cookieName: cookie.name,
      expiresAtMs: Number(cookie.expires) * 1000,
    }))
    .filter((cookie) => Number.isFinite(cookie.expiresAtMs));

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0];
}

function disconnectBrowserClient(browser) {
  const serverBrowser = browser?._connection?.toImpl?.(browser);
  serverBrowser?._connection?.close();
}

async function readLiveCookies(platform) {
  const runtime = readJson(sharedBrowserRuntimePaths(platform).statePath);
  if (!runtime?.cdpEndpoint || runtime.role !== platform) return null;

  let browser;
  try {
    browser = await chromium.connectOverCDP(runtime.cdpEndpoint, { timeout: 3_000 });
    const context = browser.contexts()[0];
    if (!context) return null;
    return await context.cookies();
  } catch {
    return null;
  } finally {
    if (browser) disconnectBrowserClient(browser);
  }
}

async function inspect(platform, storageStatePath) {
  const liveCookies = await readLiveCookies(platform);
  const liveExpiry = findExpiry(liveCookies, platform);
  if (liveExpiry) {
    return {
      platform,
      source: "live-browser",
      cookieName: liveExpiry.cookieName,
      expiresAt: new Date(liveExpiry.expiresAtMs).toISOString(),
    };
  }

  const persisted = readJson(storageStatePath);
  const persistedExpiry = findExpiry(persisted?.cookies, platform);
  return {
    platform,
    source: "storage-state",
    cookieName: persistedExpiry?.cookieName || null,
    expiresAt: persistedExpiry
      ? new Date(persistedExpiry.expiresAtMs).toISOString()
      : null,
  };
}

const sessions = await Promise.all([
  inspect("naver", naverStorageStatePath),
  inspect("spacecloud", spaceCloudStorageStatePath),
]);

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  sessions,
}));
