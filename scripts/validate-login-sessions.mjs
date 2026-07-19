import { existsSync } from "node:fs";
import {
  launchRpaBrowser,
  newRpaContext,
} from "../rpa/lib/browser.mjs";
import { optionalEnv } from "../rpa/lib/env.mjs";
import {
  naverStorageStatePath,
  spaceCloudStorageStatePath,
} from "../rpa/lib/paths.mjs";
import {
  shouldUseSpaceCloudProxy,
} from "../rpa/lib/spacecloud-session.mjs";

const checks = [
  {
    name: "naver",
    storageState: naverStorageStatePath,
    url: optionalEnv(
      "NAVER_BIZ_ITEMS_URL",
      "https://partner.booking.naver.com/bizes/1473933/biz-items",
    ),
    useProxy: true,
    isAuthenticated(url, text) {
      return (
        /partner\.booking\.naver\.com/i.test(url) &&
        !/nid\.naver\.com|\/login/i.test(url) &&
        !/로그인\s*(?:이|을)?\s*필요|네이버로 로그인/i.test(text)
      );
    },
  },
  {
    name: "spacecloud",
    storageState: spaceCloudStorageStatePath,
    url: optionalEnv(
      "SPACECLOUD_HOST_HOME_URL",
      "https://partner.spacecloud.kr/reservation/",
    ),
    useProxy: shouldUseSpaceCloudProxy(),
    requireAuthenticatedPartnerApi: true,
    isAuthenticated(url, text) {
      return (
        /partner\.spacecloud\.kr/i.test(url) &&
        !/\/login|\/auth/i.test(url) &&
        !/로그인이 필요|다시 로그인|로그인해 주세요/i.test(text)
      );
    },
  },
];

async function validate(check) {
  if (!existsSync(check.storageState)) {
    return { name: check.name, authenticated: false, reason: "missing-storage-state" };
  }

  const browser = await launchRpaBrowser({
    headless: true,
    useProxy: check.useProxy,
    reuse: false,
  });

  try {
    const context = await newRpaContext(browser, {
      storageState: check.storageState,
    });
    const page = await context.newPage();
    let authenticatedPartnerApi = false;
    page.on("response", (apiResponse) => {
      if (!check.requireAuthenticatedPartnerApi) return;
      if (!/^https:\/\/api\.spacecloud\.kr\/partner\//i.test(apiResponse.url())) return;
      if (apiResponse.status() < 200 || apiResponse.status() >= 300) return;
      if (apiResponse.request().method() === "OPTIONS") return;
      if (apiResponse.request().headers().authorization) authenticatedPartnerApi = true;
    });
    const response = await page.goto(check.url, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3_000);

    const finalUrl = page.url();
    const title = await page.title();
    const text = await page.locator("body").innerText().catch(() => "");
    return {
      name: check.name,
      authenticated: check.isAuthenticated(finalUrl, text)
        && (!check.requireAuthenticatedPartnerApi || authenticatedPartnerApi),
      authenticatedPartnerApi: check.requireAuthenticatedPartnerApi
        ? authenticatedPartnerApi
        : undefined,
      status: response?.status() ?? null,
      finalUrl,
      title,
      network: check.useProxy ? "proxy" : "direct",
    };
  } finally {
    await browser.close();
  }
}

const results = [];
for (const check of checks) {
  try {
    results.push(await validate(check));
  } catch (error) {
    results.push({
      name: check.name,
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.authenticated)) process.exitCode = 1;
