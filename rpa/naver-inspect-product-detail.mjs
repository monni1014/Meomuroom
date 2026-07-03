import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { humanClickElement } from "./lib/human.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const productUrl = process.argv[2];

async function main() {
  if (!productUrl) throw new Error("Pass product detail URL.");
  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }

  const browser = await launchRpaBrowser({ headless: false });
  try {
    const context = await newRpaContext(browser, { storageState: naverStorageStatePath });
    const page = await context.newPage();
    await page.goto(productUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    await humanClickElement(page, page.getByText("\uc77c\uc815\uc124\uc815", { exact: false }).first(), "inspect schedule tab");
    await page.waitForTimeout(4_000);

    const data = await page.evaluate(() => {
      return [...document.querySelectorAll("input, button, [role='switch'], [role='button']")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            tag: element.tagName,
            text: (element.textContent || "").replace(/\s+/g, " ").trim(),
            aria: element.getAttribute("aria-label"),
            role: element.getAttribute("role"),
            type: element.getAttribute("type"),
            checked: element.checked ?? null,
            backgroundColor: style.backgroundColor,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        })
        .filter((item) => item.w > 0 && item.h > 0);
    });

    const screenshot = await saveScreenshot(page, "naver-inspect-product-detail");
    console.log(JSON.stringify({ currentUrl: page.url(), screenshot, data }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Inspect detail failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
