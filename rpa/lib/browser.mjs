import { chromium } from "playwright";
import * as proxyChain from "proxy-chain";
import { getUpstreamProxyUrl } from "./env.mjs";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const BLOCKED_FILE_EXTENSIONS = /\.(?:avif|gif|ico|jpe?g|mp3|mp4|ogg|png|svg|ttf|webm|webp|woff2?)($|[?#])/i;
const BLOCKED_URL_PATTERNS =
  /analytics|googletagmanager|doubleclick|adservice|criteo|hotjar|clarity|amplitude|mixpanel|facebook\.com\/tr|sentry/i;

export async function launchRpaBrowser({ headless = false, useProxy = true } = {}) {
  const localProxyUrl = useProxy ? await proxyChain.anonymizeProxy(getUpstreamProxyUrl()) : null;
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
