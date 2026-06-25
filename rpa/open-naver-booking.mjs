import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { ensureDir, naverStorageStatePath, screenshotDir } from "./lib/paths.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const detailUrl = process.argv[2] || optionalEnv("NAVER_BOOKING_DETAIL_URL", "");
  if (!detailUrl) {
    throw new Error("Pass a Naver booking detail URL as an argument or set NAVER_BOOKING_DETAIL_URL in .env");
  }

  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }

  const browser = await launchRpaBrowser({ headless: false });

  try {
    const context = await newRpaContext(browser, {
      storageState: naverStorageStatePath,
    });
    const page = await context.newPage();

    await page.goto(detailUrl, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });

    await page.waitForTimeout(2_000);
    ensureDir(screenshotDir);
    const screenshotPath = resolve(screenshotDir, `naver-booking-${timestamp()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log("\nOpened Naver booking detail page.");
    console.log("Current URL :", page.url());
    console.log("Screenshot  :", screenshotPath);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Open Naver booking failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
