import { chromium } from "playwright";
import * as proxyChain from "proxy-chain";
import { getUpstreamProxyUrl } from "./env.mjs";

const IPROYAL_ME_URL = "https://resi-api.iproyal.com/v1/me";
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const BLOCKED_FILE_EXTENSIONS = /\.(?:avif|gif|ico|jpe?g|mp3|mp4|ogg|png|svg|ttf|webm|webp|woff2?)($|[?#])/i;
const BLOCKED_URL_PATTERNS =
  /analytics|googletagmanager|doubleclick|adservice|criteo|hotjar|clarity|amplitude|mixpanel|facebook\.com\/tr|sentry/i;

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

async function shouldUseProxy({ useProxy, forceProxy }) {
  if (!useProxy) return false;
  if (forceProxy) return true;

  if (!readBooleanEnv("RPA_USE_PROXY", true)) {
    console.log("[RPA network] RPA_USE_PROXY=false. Use current IP.");
    return false;
  }

  return hasUsableProxyTraffic();
}

export async function launchRpaBrowser({ headless = false, useProxy = true, forceProxy = false } = {}) {
  const proxyEnabled = await shouldUseProxy({ useProxy, forceProxy });
  let localProxyUrl = null;

  if (proxyEnabled) {
    try {
      localProxyUrl = await proxyChain.anonymizeProxy(getUpstreamProxyUrl());
    } catch (error) {
      if (forceProxy || !readBooleanEnv("RPA_PROXY_DIRECT_FALLBACK", true)) throw error;
      console.warn(
        `[RPA network] Proxy initialization failed. Use current IP: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  console.log(`[RPA network] Browser connection: ${localProxyUrl ? "IPRoyal proxy" : "current IP"}`);
  const browser = await chromium.launch({
    headless,
    ...(localProxyUrl ? { proxy: { server: localProxyUrl } } : {}),
  });

  const closeBrowser = browser.close.bind(browser);
  browser.close = async (...args) => {
    try {
      await closeBrowser(...args);
    } finally {
      if (localProxyUrl) {
        await proxyChain.closeAnonymizedProxy(localProxyUrl, true);
      }
    }
  };

  return browser;
}

export async function newRpaContext(browser, options = {}) {
  const { blockHeavyResources = true, extraHTTPHeaders, ...contextOptions } = options;
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

  return context;
}
