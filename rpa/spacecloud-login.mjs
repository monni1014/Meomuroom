import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { ensureParentDir, spaceCloudStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

function hasArg(name) {
  return process.argv.includes(name);
}

async function main() {
  const startUrl = optionalEnv("SPACECLOUD_HOST_HOME_URL", "https://www.spacecloud.kr/");
  const useProxy = !hasArg("--no-proxy");
  const browser = await launchRpaBrowser({ headless: false, useProxy });

  try {
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

    const screenshot = await saveScreenshot(page, "spacecloud-login-check");
    const currentUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    console.log(`\nCurrent URL: ${currentUrl}`);
    console.log(`Screenshot: ${screenshot}`);
    console.log(`Visible text sample: ${bodyText.slice(0, 500).replace(/\s+/g, " ")}`);

    ensureParentDir(spaceCloudStorageStatePath);
    await context.storageState({ path: spaceCloudStorageStatePath });
    console.log(`\nSaved SpaceCloud login session: ${spaceCloudStorageStatePath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("SpaceCloud login session save failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
