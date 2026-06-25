import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const url = optionalEnv("NAVER_BIZ_ITEMS_URL", "https://partner.booking.naver.com/bizes/1473933/biz-items");

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

    const data = await page.evaluate(() => {
      return [...document.querySelectorAll("a[href], button, [role='button'], input")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return {
            tag: element.tagName,
            text,
            aria: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            href: element.getAttribute("href"),
            role: element.getAttribute("role"),
            type: element.getAttribute("type"),
            checked: element.checked ?? null,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        })
        .filter((item) => item.text || item.aria || item.title || item.href || item.role || item.type);
    });

    const screenshot = await saveScreenshot(page, "naver-inspect-products");
    console.log(JSON.stringify({ currentUrl: page.url(), screenshot, data }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Inspect failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
