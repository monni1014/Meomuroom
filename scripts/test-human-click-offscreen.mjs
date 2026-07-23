import assert from "node:assert/strict";
import { chromium } from "playwright";
import { humanClickElement } from "../rpa/lib/human.mjs";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 2400px; }
      #target { display: block; margin-top: 120px; width: 180px; height: 48px; }
      #sticky { position: fixed; inset: 0 0 auto 0; height: 72px; background: white; z-index: 10; }
    </style>
    <div id="sticky">sticky header</div>
    <button id="target" onclick="window.clicked = true">예약추가</button>
  `);
  await page.evaluate(() => window.scrollTo(0, 1_500));

  const target = page.locator("#target");
  const before = await target.boundingBox();
  assert.ok(before && before.y < 0, "fixture must start with the button above the viewport");

  await humanClickElement(page, target, "offscreen regression target");

  assert.equal(await page.evaluate(() => window.clicked === true), true);
  const after = await target.boundingBox();
  assert.ok(after && after.y >= 72 && after.y + after.height <= 600, "button must be moved into a safe viewport area");
  console.log("Offscreen human click regression test passed");
} finally {
  await browser.close();
}
