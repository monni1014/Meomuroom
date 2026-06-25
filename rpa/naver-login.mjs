import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { ensureParentDir, naverStorageStatePath } from "./lib/paths.mjs";

async function main() {
  const startUrl = optionalEnv("NAVER_PARTNER_HOME_URL", "https://partner.booking.naver.com/");
  const browser = await launchRpaBrowser({ headless: false });

  try {
    const context = await newRpaContext(browser);
    const page = await context.newPage();

    await page.goto(startUrl, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });

    console.log("\nNaver login browser opened.");
    console.log("1. Log in manually in the opened browser.");
    console.log("2. Move to the SmartPlace/Booking admin page if needed.");
    console.log("3. Come back here and press Enter.");

    const rl = createInterface({ input, output });
    await rl.question("\nPress Enter after login is complete...");
    rl.close();

    ensureParentDir(naverStorageStatePath);
    await context.storageState({ path: naverStorageStatePath });
    console.log(`\nSaved Naver login session: ${naverStorageStatePath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Naver login session save failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
