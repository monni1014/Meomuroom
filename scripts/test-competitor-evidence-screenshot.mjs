import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  clearCompetitorEvidenceViewport,
  evidenceHours,
  formatEvidenceRange,
  prepareCompetitorEvidenceViewport,
} from "../rpa/lib/competitor-evidence.mjs";

assert.deepEqual(evidenceHours(18, 20), [18, 19]);
assert.equal(formatEvidenceRange(18, 20), "18:00~20:00");
assert.deepEqual(evidenceHours(20, 18), []);

const workDir = await mkdtemp(join(tmpdir(), "memoroom-evidence-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.setContent(`
    <!doctype html>
    <html lang="ko">
      <body style="margin:0;font-family:sans-serif">
        <div style="height:720px">calendar area</div>
        <ul style="margin:0;padding:20px;list-style:none">
          ${Array.from({ length: 16 }, (_, index) => {
            const hour = index + 8;
            const period = hour < 12 ? "오전" : "오후";
            const display = hour > 12 ? hour - 12 : hour;
            return `<li class="time_item${hour === 18 ? " disabled" : ""}" style="height:42px;margin:6px;border:1px solid #ddd"><span class="time_text">${period} ${display}시</span></li>`;
          }).join("")}
        </ul>
      </body>
    </html>
  `);

  const result = await prepareCompetitorEvidenceViewport(page, {
    competitorName: "트라이그라운드 A",
    dateKey: "2026-08-14",
    startHour: 18,
    endHour: 20,
    reasonCode: "CANCELLATION_PENDING_CONFIRMATION",
  });
  assert.deepEqual(result.foundHours, [18, 19]);
  assert.deepEqual(result.missingHours, []);
  assert.ok(result.visibility.every((item) => item.visible));
  assert.equal(await page.locator("[data-memoroom-evidence-target=true]").count(), 2);
  assert.match(await page.locator("[data-memoroom-evidence-overlay=true]").innerText(), /2026-08-14/);
  assert.match(await page.locator("[data-memoroom-evidence-overlay=true]").innerText(), /18:00~20:00/);

  const imagePath = join(workDir, "focused.png");
  await page.screenshot({ path: imagePath, fullPage: false });
  const png = await readFile(imagePath);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");

  await clearCompetitorEvidenceViewport(page);
  assert.equal(await page.locator("[data-memoroom-evidence-overlay=true]").count(), 0);
  assert.equal(await page.locator("[data-memoroom-evidence-target=true]").count(), 0);
} finally {
  await browser.close();
  await rm(workDir, { recursive: true, force: true });
}

console.log("Competitor evidence screenshot focus tests passed");
