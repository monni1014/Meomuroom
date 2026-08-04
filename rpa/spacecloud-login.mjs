import { createInterface } from "node:readline/promises";
import { rename, rm } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import {
  ensureParentDir,
  secureAuthFileForService,
  spaceCloudStorageStatePath,
} from "./lib/paths.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";
import { saveSpaceCloudSessionMeta } from "./lib/spacecloud-session.mjs";

function hasArg(name) {
  return process.argv.includes(name);
}

function isAuthenticatedPartnerApiResponse(response) {
  if (!/^https:\/\/api\.spacecloud\.kr\/partner\//i.test(response.url())) return false;
  if (response.status() < 200 || response.status() >= 300) return false;
  if (response.request().method() === "OPTIONS") return false;
  return Boolean(response.request().headers().authorization);
}

async function main() {
  const startUrl = optionalEnv("SPACECLOUD_HOST_HOME_URL", "https://www.spacecloud.kr/");
  const useProxy = !hasArg("--no-proxy");
  const releaseLoginLock = await acquireProcessLock("rpa/.locks/spacecloud-login.lock", {
    label: "SpaceCloud login",
    staleMs: 15 * 60 * 1000,
    failIfLocked: true,
  });
  let browser;

  try {
    browser = await launchRpaBrowser({
      headless: false,
      useProxy,
      forceProxy: useProxy,
    });
    const context = await newRpaContext(browser, { blockHeavyResources: false });
    const page = await context.newPage();

    await page.goto(startUrl, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });

    console.log("\nSpaceCloud login browser opened.");
    console.log(`Proxy for login: ${useProxy ? "on" : "off"}`);
    console.log("1. Log in manually in the opened browser.");
    console.log("2. Move to the SpaceCloud host center if needed.");
    console.log("3. If the login page shows an error, leave it open and press Enter here so a screenshot is saved.");
    console.log("4. If login succeeds, press Enter here to save the session.");

    const rl = createInterface({ input, output });
    await rl.question("\nPress Enter after login succeeds or an error is visible...");
    rl.close();

    // Verify the saved session against the host reservation page, not just the
    // browser screen where the user happened to press Enter.
    const authenticatedResponse = page.waitForResponse(
      isAuthenticatedPartnerApiResponse,
      { timeout: 60_000 },
    );
    await page.goto("https://partner.spacecloud.kr/reservation/", {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });
    await authenticatedResponse;
    await page.waitForTimeout(3_000);

    const screenshot = await saveScreenshot(page, "spacecloud-login-check");
    const currentUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const normalizedBody = bodyText.replace(/\s+/g, " ").trim();
    const isLoggedIn =
      /호스트\s*로그아웃/.test(normalizedBody) ||
      (/예약\s*관리\s*리스트/.test(normalizedBody) && !/호스트\s*로그인/.test(normalizedBody));
    console.log(`\nCurrent URL: ${currentUrl}`);
    console.log(`Screenshot: ${screenshot}`);
    console.log(`Visible text sample: ${normalizedBody.slice(0, 500)}`);

    if (!isLoggedIn) {
      throw new Error(
        "SpaceCloud host login was not confirmed. Log in until '호스트 로그아웃' is visible, then press Enter.",
      );
    }

    ensureParentDir(spaceCloudStorageStatePath);
    const temporaryStatePath = `${spaceCloudStorageStatePath}.${process.pid}.tmp`;
    await context.storageState({ path: temporaryStatePath, indexedDB: true });
    await rm(spaceCloudStorageStatePath, { force: true });
    await rename(temporaryStatePath, spaceCloudStorageStatePath);
    secureAuthFileForService(spaceCloudStorageStatePath);
    const sessionMeta = saveSpaceCloudSessionMeta({ useProxy });
    console.log(`\nSaved SpaceCloud login session: ${spaceCloudStorageStatePath}`);
    console.log(`SpaceCloud session network: ${sessionMeta.networkMode}`);
  } finally {
    await browser?.close().catch(() => {});
    await releaseLoginLock();
  }
}

main().catch((error) => {
  console.error("SpaceCloud login session save failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
