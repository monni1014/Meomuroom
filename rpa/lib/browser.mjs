import { chromium } from "playwright";
import * as proxyChain from "proxy-chain";
import { getUpstreamProxyUrl } from "./env.mjs";

export async function launchRpaBrowser({ headless = false } = {}) {
  const localProxyUrl = await proxyChain.anonymizeProxy(getUpstreamProxyUrl());
  const browser = await chromium.launch({
    headless,
    proxy: {
      server: localProxyUrl,
    },
  });

  const closeBrowser = browser.close.bind(browser);
  browser.close = async (...args) => {
    try {
      await closeBrowser(...args);
    } finally {
      await proxyChain.closeAnonymizedProxy(localProxyUrl, true);
    }
  };

  return browser;
}

export async function newRpaContext(browser, options = {}) {
  const { blockHeavyResources = true, ...contextOptions } = options;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...contextOptions,
  });

  if (blockHeavyResources) {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();

      if (["image", "media", "font"].includes(resourceType)) {
        await route.abort();
        return;
      }

      if (/analytics|googletagmanager|doubleclick|adservice|criteo|hotjar|clarity/i.test(url)) {
        await route.abort();
        return;
      }

      await route.continue();
    });
  }

  return context;
}
