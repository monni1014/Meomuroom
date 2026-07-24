import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  assertRpaExecutionAllowed,
  getProxyConfig,
  getProxyProvider,
} from "./env.mjs";

const IPROYAL_ME_URL = "https://resi-api.iproyal.com/v1/me";
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const BLOCKED_FILE_EXTENSIONS = /\.(?:avif|gif|ico|jpe?g|mp3|mp4|ogg|png|svg|ttf|webm|webp|woff2?)($|[?#])/i;
const BLOCKED_URL_PATTERNS =
  /analytics|googletagmanager|doubleclick|adservice|criteo|hotjar|clarity|amplitude|mixpanel|facebook\.com\/tr|sentry/i;
const SHARED_BROWSER_ROLES = new Set(["naver", "spacecloud"]);

export function normalizeSharedBrowserRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!SHARED_BROWSER_ROLES.has(role)) {
    throw new Error(`Shared RPA Chromium requires an isolated role: ${[...SHARED_BROWSER_ROLES].join(", ")}.`);
  }
  return role;
}

export function sharedBrowserRuntimePaths(value) {
  const role = normalizeSharedBrowserRole(value);
  const runtimeDir = resolve("rpa/.runtime");
  return {
    role,
    runtimeDir,
    statePath: resolve(runtimeDir, `browser-host-${role}.json`),
    startLockPath: resolve(runtimeDir, `browser-host-${role}-starting.lock`),
    profileDir: resolve(runtimeDir, `chromium-profile-${role}`),
    logPath: resolve(runtimeDir, `browser-host-${role}.log`),
  };
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function hasUsableProxyTraffic() {
  if (!readBooleanEnv("RPA_PROXY_DIRECT_FALLBACK", true)) return true;

  // Proxy-Seller ISP proxies are fixed-IP subscriptions with no traffic
  // balance. The legacy IPRoyal balance check must never decide whether a
  // different provider is used, even if an old IPRoyal token remains in .env.
  if (getProxyProvider().trim().toLowerCase() !== "iproyal") return true;

  const apiToken = process.env.IPROYAL_API_TOKEN;
  if (!apiToken) return true;

  try {
    const response = await fetch(IPROYAL_ME_URL, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn(`[RPA network] Could not check proxy traffic (${response.status}). Keep proxy mode.`);
      return true;
    }

    const payload = await response.json();
    const availableGb = Number(payload?.available_traffic);
    if (!Number.isFinite(availableGb)) {
      console.warn("[RPA network] Proxy traffic response was invalid. Keep proxy mode.");
      return true;
    }

    const fallbackGb = Math.max(0, readNumberEnv("IPROYAL_PROXY_DIRECT_FALLBACK_GB", 0.01));
    if (availableGb <= fallbackGb) {
      console.warn(
        `[RPA network] Proxy traffic ${availableGb.toFixed(3)}GB <= ${fallbackGb.toFixed(3)}GB. Use current IP.`,
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      `[RPA network] Proxy traffic check failed. Keep proxy mode: ${error instanceof Error ? error.message : error}`,
    );
    return true;
  }
}

export async function shouldUseRpaProxy({ useProxy, forceProxy }) {
  if (!useProxy) return false;
  if (forceProxy) return true;

  if (!readBooleanEnv("RPA_USE_PROXY", true)) {
    console.log("[RPA network] RPA_USE_PROXY=false. Use current IP.");
    return false;
  }

  return hasUsableProxyTraffic();
}

export function resolveRpaHeadless(fallback = process.env.NODE_ENV === "production") {
  return readBooleanEnv("RPA_HEADLESS", fallback);
}

function contextRoleFromOptions(options) {
  if (options.rpaRole) return String(options.rpaRole);
  const storageState = typeof options.storageState === "string" ? options.storageState.toLowerCase() : "";
  if (storageState.includes("naver")) return "naver";
  if (storageState.includes("spacecloud")) return "spacecloud";
  return "generic";
}

export async function installRpaResourceBlocking(context) {
  await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await context.route("**/*", async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (BLOCKED_RESOURCE_TYPES.has(resourceType) || BLOCKED_FILE_EXTENSIONS.test(url)) {
      await route.abort();
      return;
    }

    if (BLOCKED_URL_PATTERNS.test(url)) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

function decorateSharedBrowser(browser, { useProxy, forceProxy, sharedBrowserRole }) {
  browser.__memoroomShared = true;
  browser.__memoroomSharedRole = sharedBrowserRole;
  browser.__memoroomUseProxy = useProxy;
  browser.__memoroomForceProxy = forceProxy;
  browser.close = async () => {
    // connectOverCDP creates a separate CDP transport for each RPA process.
    // Closing only Playwright's client Connection leaves that transport alive,
    // so the child process never exits even after its work is complete. Close
    // the server-side CDP transport while leaving the detached Chromium host
    // and its fixed pages running for the next job.
    const serverBrowser = browser._connection?.toImpl?.(browser);
    serverBrowser?._connection?.close();

    if (browser.isConnected()) {
      await Promise.race([
        new Promise((resolvePromise) => browser.once("disconnected", resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
      ]);
    }
  };
  return browser;
}

function readSharedBrowserState(sharedBrowserRole) {
  const { statePath } = sharedBrowserRuntimePaths(sharedBrowserRole);
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function connectSharedBrowser({ useProxy, forceProxy, sharedBrowserRole }) {
  const state = readSharedBrowserState(sharedBrowserRole);
  if (!state?.cdpEndpoint || state.role !== sharedBrowserRole) return null;

  try {
    const browser = await chromium.connectOverCDP(state.cdpEndpoint, { timeout: 2_500 });
    return decorateSharedBrowser(browser, { useProxy, forceProxy, sharedBrowserRole });
  } catch {
    return null;
  }
}

async function ensureSharedBrowser({ headless, useProxy, forceProxy, sharedBrowserRole }) {
  const role = normalizeSharedBrowserRole(sharedBrowserRole);
  const paths = sharedBrowserRuntimePaths(role);
  const connected = await connectSharedBrowser({ useProxy, forceProxy, sharedBrowserRole: role });
  if (connected) return connected;

  const { mkdirSync, openSync, closeSync, rmSync } = await import("node:fs");
  mkdirSync(paths.runtimeDir, { recursive: true });
  const systemdManaged = readBooleanEnv("RPA_SHARED_BROWSER_SYSTEMD_MANAGED", false);

  let ownsStartLock = false;
  if (!systemdManaged) {
    try {
      const handle = openSync(paths.startLockPath, "wx");
      closeSync(handle);
      ownsStartLock = true;
    } catch {
      // Another RPA client is already starting the host.
    }
  }

  if (ownsStartLock) {
    const logHandle = openSync(paths.logPath, "a");
    try {
      const child = spawn(process.execPath, [
        resolve("rpa/browser-host.mjs"),
        `--headless=${headless ? "true" : "false"}`,
        `--role=${role}`,
        `--use-proxy=${useProxy ? "true" : "false"}`,
        `--force-proxy=${forceProxy ? "true" : "false"}`,
      ], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", logHandle, logHandle],
        env: process.env,
        windowsHide: headless,
      });
      child.unref();
    } finally {
      closeSync(logHandle);
    }
  }

  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const browser = await connectSharedBrowser({
        useProxy,
        forceProxy,
        sharedBrowserRole: role,
      });
      if (browser) return browser;
    }
  } finally {
    if (ownsStartLock) rmSync(paths.startLockPath, { force: true });
  }

  const recoveryHint = systemdManaged
    ? `Check memoroom-rpa-browser@${role}.service.`
    : `Check ${paths.logPath}.`;
  throw new Error(`Shared RPA Chromium (${role}) did not start within 20 seconds. ${recoveryHint}`);
}

export async function launchRpaBrowser({
  headless = resolveRpaHeadless(),
  useProxy = true,
  forceProxy = false,
  reuse = false,
  sharedBrowserRole,
} = {}) {
  assertRpaExecutionAllowed();

  if (reuse) {
    const role = normalizeSharedBrowserRole(sharedBrowserRole);
    console.log(`[RPA browser] Reuse isolated ${role} Chromium (${headless ? "headless" : "headed"}).`);
    return ensureSharedBrowser({
      headless,
      useProxy,
      forceProxy,
      sharedBrowserRole: role,
    });
  }

  const proxyEnabled = await shouldUseRpaProxy({ useProxy, forceProxy });
  const proxy = proxyEnabled ? getProxyConfig() : null;

  console.log(
    `[RPA network] Browser connection: ${proxy ? `${getProxyProvider()} proxy` : "current IP"}`,
  );
  return chromium.launch({
    headless,
    ...(proxy ? {
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
    } : {}),
  });
}

export async function newRpaContext(browser, options = {}) {
  const {
    blockHeavyResources = true,
    extraHTTPHeaders,
    rpaRole,
    reusePage = browser.__memoroomShared === true,
    ...contextOptions
  } = options;
  const role = contextRoleFromOptions({ ...options, rpaRole });

  if (browser.__memoroomShared) {
    if (browser.__memoroomSharedRole !== role) {
      throw new Error(
        `Shared RPA Chromium role mismatch: expected ${role}, connected ${browser.__memoroomSharedRole}.`,
      );
    }
    const sharedContext = browser.contexts()[0];
    if (!sharedContext) throw new Error("Shared RPA Chromium has no persistent context.");
    return decorateReusableContext(sharedContext, reusePage, role);
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    serviceWorkers: "block",
    extraHTTPHeaders: {
      "Save-Data": "on",
      ...extraHTTPHeaders,
    },
    ...contextOptions,
  });

  if (blockHeavyResources) {
    await installRpaResourceBlocking(context);
  }

  return decorateReusableContext(context, reusePage, role);
}

async function readPageRole(page) {
  return page.evaluate(() => window.__MEMOROOM_RPA_PAGE_ROLE__ || null).catch(() => null);
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
  }, role).catch(() => {});
}

function decorateReusableContext(context, reusePage, role = "generic") {
  if (!reusePage || context.__memoroomReusePagePatched) return context;

  const createPage = context.newPage.bind(context);
  context.newPage = async () => {
    if (role === "competitor") {
      const page = await createPage();
      await assignPageRole(page, role);
      return page;
    }

    const pages = context.pages().filter((page) => !page.isClosed());
    for (const page of pages) {
      if (await readPageRole(page) === role) return page;
    }

    const page = await createPage();
    await assignPageRole(page, role);
    return page;
  };
  context.__memoroomReusePagePatched = true;
  return context;
}
