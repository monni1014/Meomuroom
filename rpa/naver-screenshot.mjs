import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const url = process.argv[2] || optionalEnv("NAVER_BIZ_ITEMS_URL", "https://partner.booking.naver.com/bizes/1473933/biz-items");

async function main() {
  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }

  const browser = await launchRpaBrowser({ headless: false });
  try {
    const context = await newRpaContext(browser, { storageState: naverStorageStatePath });
    const page = await context.newPage();
    await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    const screenshot = await saveScreenshot(page, "naver-current-page");
    console.log("Current URL:", page.url());
    console.log("Screenshot:", screenshot);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Screenshot failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
