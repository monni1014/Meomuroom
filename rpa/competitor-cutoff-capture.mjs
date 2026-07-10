import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs } from "./lib/cli.mjs";

const RESULT_PREFIX = "__CUTOFF_CAPTURE_RESULT__";
const SYNERGY_URL = "https://m.booking.naver.com/booking/10/bizes/1018820/items/5442967";

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function kstDateKey(date = new Date()) {
  const parts = kstParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function captureTimeKey(date = new Date()) {
  const parts = kstParts(date);
  return `${parts.hour}-${parts.minute}-${parts.second}`;
}

function targetCalendarIndex(targetKey) {
  const [year, month, day] = targetKey.split("-").map(Number);
  const firstDay = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+09:00`).getDay();
  return firstDay + day - 1;
}

async function selectDate(page, targetKey) {
  await page.waitForSelector(".calendar_title", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('button[data-click-code="calendar.date"]').length >= 28,
    null,
    { timeout: 30_000 },
  );

  const buttons = page.locator('button[data-click-code="calendar.date"]');
  const index = targetCalendarIndex(targetKey);
  const count = await buttons.count();
  if (index < 0 || index >= count) throw new Error(`Calendar index ${index} is outside ${count} buttons`);

  const button = buttons.nth(index);
  if (await button.isDisabled()) throw new Error(`${targetKey} is not selectable`);
  await button.click();

  const expectedDay = Number(targetKey.slice(-2));
  await page.waitForFunction(
    ({ day }) => Number(document.querySelector(".calendar_date.selected .num")?.textContent?.trim()) === day,
    { day: expectedDay },
    { timeout: 20_000 },
  );
  await page.waitForTimeout(400);
}

async function readSlots(page) {
  return page.evaluate(() => {
    let period = "AM";
    return [...document.querySelectorAll(".time_item")].map((element) => {
      const text = (element.querySelector(".time_text")?.textContent || element.textContent || "")
        .replace(/\s+/g, "")
        .trim();
      if (text.includes("오전")) period = "AM";
      if (text.includes("오후")) period = "PM";
      const match = text.match(/(\d{1,2})시/);
      if (!match) return null;
      let hour = Number(match[1]);
      if (period === "PM" && hour !== 12) hour += 12;
      if (period === "AM" && hour === 12) hour = 0;
      return {
        hour,
        label: text,
        available: !element.classList.contains("disabled"),
        className: element.className,
      };
    }).filter(Boolean);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const targetKey = String(args.date || kstDateKey());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetKey)) throw new Error("--date must be YYYY-MM-DD");

  const checkedAt = new Date();
  const timeKey = captureTimeKey(checkedAt);
  const outputDir = path.resolve("rpa", "screenshots", "synergy-cutoff-study", targetKey);
  const pagePath = path.join(outputDir, `${timeKey}-calendar.png`);
  const timePath = path.join(outputDir, `${timeKey}-times-early.png`);
  const lateTimePath = path.join(outputDir, `${timeKey}-times-late.png`);
  const dataPath = path.join(outputDir, `${timeKey}.json`);
  await mkdir(outputDir, { recursive: true });

  const browser = await launchRpaBrowser({ headless: true, useProxy: false });
  try {
    const context = await newRpaContext(browser, {
      blockHeavyResources: true,
      viewport: { width: 1200, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(SYNERGY_URL, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await selectDate(page, targetKey);
    const slots = await readSlots(page);

    const calendarContent = page.locator(".section_content:has(.calendar_title)");
    if (await calendarContent.count() !== 1) throw new Error("Could not identify the calendar section uniquely");
    await calendarContent.screenshot({ path: pagePath });
    const timeArea = calendarContent.locator(".time_area");
    const savedTimePath = await timeArea.count() ? timePath : null;
    if (savedTimePath) await timeArea.screenshot({ path: savedTimePath });
    let savedLateTimePath = null;
    if (savedTimePath) {
      const nextButton = timeArea.locator(".slick-next:not(.slick-disabled)");
      if (await nextButton.count() === 1) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const activeNextButton = timeArea.locator(".slick-next:not(.slick-disabled)");
          if (await activeNextButton.count() !== 1) break;
          await activeNextButton.evaluate((element) => element.click());
          await page.waitForTimeout(120);
        }
        await timeArea.screenshot({ path: lateTimePath });
        savedLateTimePath = lateTimePath;
      }
    }

    const payload = {
      competitorId: "synergy",
      targetKey,
      checkedAt: checkedAt.toISOString(),
      checkedAtKst: `${kstDateKey(checkedAt)} ${timeKey.replaceAll("-", ":")}`,
      slots,
      pagePath,
      timePath: savedTimePath,
      lateTimePath: savedLateTimePath,
    };
    await writeFile(dataPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`${RESULT_PREFIX}${JSON.stringify({ ...payload, dataPath })}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Synergy cutoff capture failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
