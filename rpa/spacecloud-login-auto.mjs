import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { rename, rm } from "node:fs/promises";
import { optionalEnv } from "./lib/env.mjs";
import { ensureParentDir, spaceCloudStorageStatePath } from "./lib/paths.mjs";
import { saveSpaceCloudSessionMeta } from "./lib/spacecloud-session.mjs";

const CHECK_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 10 * 60 * 1000;

function hasLoggedInText(text) {
  return /호스트\s*로그아웃|예약\s*관리\s*리스트|예약\s*\/\s*캘린더/.test(text)
    && !/^\s*로그인\s*$|회원가입/.test(text);
}

function isAuthenticatedPartnerApiResponse(response) {
  if (!/^https:\/\/api\.spacecloud\.kr\/partner\//i.test(response.url())) return false;
  if (response.status() < 200 || response.status() >= 300) return false;
  if (response.request().method() === "OPTIONS") return false;
  return Boolean(response.request().headers().authorization);
}

async function verifyPartnerApiAccess(page) {
  const authenticatedResponse = page.waitForResponse(
    isAuthenticatedPartnerApiResponse,
    { timeout: 60_000 },
  );
  await page.goto("https://partner.spacecloud.kr/reservation/", {
    timeout: 60_000,
    waitUntil: "domcontentloaded",
  });
  await authenticatedResponse;

  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (!/예약\s*관리\s*리스트/.test(bodyText)) {
    throw new Error("SpaceCloud reservation page did not finish loading after API authentication.");
  }
}

async function main() {
  const startUrl = optionalEnv("SPACECLOUD_HOST_HOME_URL", "https://partner.spacecloud.kr/");
  const browser = await launchRpaBrowser({ headless: false });

  try {
    const context = await newRpaContext(browser, { blockHeavyResources: false });
    const page = await context.newPage();
    await page.goto(startUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });

    console.log("\nSpaceCloud login/check browser opened.");
    console.log("Log in in the opened browser if needed. Session will be saved automatically.");

    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await page.waitForTimeout(CHECK_INTERVAL_MS);

      const currentUrl = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const loggedIn = /partner\.spacecloud\.kr/.test(currentUrl) && hasLoggedInText(bodyText);

      console.log(`Checking SpaceCloud login... url=${currentUrl.slice(0, 100)} text=${bodyText.slice(0, 30).replace(/\s+/g, " ")}`);

      if (loggedIn) {
        console.log("SpaceCloud screen login detected. Verifying partner API access...");
        await verifyPartnerApiAccess(page);
        ensureParentDir(spaceCloudStorageStatePath);
        const temporaryStatePath = `${spaceCloudStorageStatePath}.${process.pid}.tmp`;
        await context.storageState({ path: temporaryStatePath, indexedDB: true });
        await rm(spaceCloudStorageStatePath, { force: true });
        await rename(temporaryStatePath, spaceCloudStorageStatePath);
        saveSpaceCloudSessionMeta({ useProxy: true });
        console.log(`\nVerified SpaceCloud partner API access and saved login session: ${spaceCloudStorageStatePath}`);
        return;
      }
    }

    throw new Error("Timed out waiting for SpaceCloud login.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("SpaceCloud auto login failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
