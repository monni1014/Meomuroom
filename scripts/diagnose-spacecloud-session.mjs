import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "../rpa/lib/browser.mjs";
import { spaceCloudStorageStatePath } from "../rpa/lib/paths.mjs";
import { shouldUseSpaceCloudProxy } from "../rpa/lib/spacecloud-session.mjs";

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function summarizeStorageState(state) {
  return (state.origins || []).map((origin) => ({
    origin: origin.origin,
    localStorageKeys: (origin.localStorage || []).map((entry) => entry.name).sort(),
    indexedDB: (origin.indexedDB || []).map((database) => ({
      name: database.name,
      stores: (database.stores || []).map((store) => store.name).sort(),
    })),
  }));
}

async function main() {
  if (!existsSync(spaceCloudStorageStatePath)) {
    throw new Error(`Missing SpaceCloud storage state: ${spaceCloudStorageStatePath}`);
  }

  const reuseShared = process.argv.includes("--shared");
  const browser = await launchRpaBrowser({
    headless: true,
    useProxy: shouldUseSpaceCloudProxy(),
    reuse: reuseShared,
    sharedBrowserRole: "spacecloud",
  });

  try {
    const context = await newRpaContext(browser, {
      storageState: spaceCloudStorageStatePath,
      blockHeavyResources: false,
      rpaRole: "spacecloud",
    });
    const page = await context.newPage();
    const apiTraffic = [];

    page.on("response", async (response) => {
      if (!/^https:\/\/api\.spacecloud\.kr\//i.test(response.url())) return;
      const request = response.request();
      const headers = await request.allHeaders().catch(() => ({}));
      apiTraffic.push({
        method: request.method(),
        status: response.status(),
        url: safeUrl(response.url()),
        hasAuthorizationHeader: Boolean(headers.authorization),
        headerNames: Object.keys(headers).sort(),
      });
    });

    let navigation = null;
    let navigationError = null;
    try {
      navigation = await page.goto("https://partner.spacecloud.kr/reservation/", {
        timeout: 90_000,
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      navigationError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    await page.waitForTimeout(8_000);

    const browserStorage = await page.evaluate(async () => ({
      localStorageKeys: Object.keys(localStorage).sort(),
      sessionStorageKeys: Object.keys(sessionStorage).sort(),
      indexedDBNames: typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((database) => database.name).filter(Boolean).sort()
        : [],
      bodyHasHostLogout: /호스트\s*로그아웃/.test(document.body?.innerText || ""),
      bodyHasReservationList: /예약\s*관리\s*리스트/.test(document.body?.innerText || ""),
    }));
    const capturedState = await context.storageState({ indexedDB: true });

    console.log(JSON.stringify({
      navigationStatus: navigation?.status() ?? null,
      navigationError,
      browserMode: reuseShared ? "shared" : "isolated",
      finalUrl: safeUrl(page.url()),
      browserStorage,
      capturedOrigins: summarizeStorageState(capturedState),
      apiTraffic,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
