import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { ensureParentDir, spaceCloudStorageStatePath } from "./lib/paths.mjs";

const CHECK_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 10 * 60 * 1000;

function hasLoggedInText(text) {
  return /호스트|예약|공간|정산|로그아웃|예약관리|호스트센터/.test(text)
    && !/로그인\s*$|회원가입/.test(text);
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
        ensureParentDir(spaceCloudStorageStatePath);
        await context.storageState({ path: spaceCloudStorageStatePath });
        console.log(`\nSaved SpaceCloud login session: ${spaceCloudStorageStatePath}`);
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
