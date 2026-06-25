import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs, parseHour, parseRoom, requiredArg } from "./lib/cli.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { humanDelay } from "./lib/human.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const BIZ_ITEMS_URL = "https://partner.booking.naver.com/bizes/1473933/biz-items";

const TEXT = {
  product1: "\uba38\ubb34\ub8f8 \uc608\uc57d\ud558\uae30 1",
  product2: "\uba38\ubb34\ub8f8 \uc608\uc57d\ud558\uae30 2",
  schedule: "\uc77c\uc815\uc124\uc815",
  preview: "\ubbf8\ub9ac\ubcf4\uae30",
  delete: "\uc0ad\uc81c",
  apply: "\uc801\uc6a9",
  next: "\ub0b4\uc77c",
  editRegex: "\\uc218\\uc815|\\ud3b8\\uc9d1|\\uc815\\ubcf4\\ubcc0\\uacbd|\\uc77c\\uc815\\uc124\\uc815",
};

const WEEKDAYS = [
  "\uc77c",
  "\uc6d4",
  "\ud654",
  "\uc218",
  "\ubaa9",
  "\uae08",
  "\ud1a0",
];

const ROOM_PRODUCT_NAMES = {
  "1": TEXT.product1,
  "2": TEXT.product2,
};

function usage() {
  return [
    "Usage:",
    "  npm run rpa:naver-slots -- --room=1 --date=2026-06-29 --start=09:00 --end=11:00 --mode=close --product-url=...",
    "",
    "Options:",
    "  --room=1|2",
    "  --date=YYYY-MM-DD",
    "  --start=HH:00",
    "  --end=HH:00",
    "  --mode=close|open",
    "  --product-url=... exact Naver product edit URL. Required for safety.",
    "  --apply       actually click toggles. Without this, it only navigates and screenshots.",
  ].join("\n");
}

function formatKoreanDateLabel(dateValue) {
  const date = new Date(`${dateValue}T00:00:00+09:00`);
  return `${date.getMonth() + 1}.${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

function formatPanelDateTitle(dateValue) {
  const date = new Date(`${dateValue}T00:00:00+09:00`);
  const yy = String(date.getFullYear()).slice(2);
  return `${yy}.${date.getMonth() + 1}.${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

function formatShortMonthDay(dateValue) {
  const date = new Date(`${dateValue}T00:00:00+09:00`);
  return `${date.getMonth() + 1}.${date.getDate()}`;
}

async function clickTextIfVisible(page, text, timeout = 15_000) {
  const locator = page.getByText(text, { exact: false }).first();
  await locator.waitFor({ state: "visible", timeout });
  await humanDelay(page, "before text click", 700, 1700);
  await locator.click();
  await humanDelay(page, "after text click", 700, 1600);
}

async function openProduct(page, productName) {
  throw new Error(
    `Blocked unsafe product-list click for ${productName}. Pass --product-url with the exact product edit URL instead.`
  );
}

async function openScheduleTab(page) {
  await clickTextIfVisible(page, TEXT.schedule, 20_000);
  await humanDelay(page, "after schedule tab", 900, 2200);
  await closeSlotPanelIfOpen(page);
  await page.keyboard.press("Escape");
  await humanDelay(page, "after safety escape", 700, 1600);
}

async function closeSlotPanelIfOpen(page) {
  const hasOpenPanel = await page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    return [...document.querySelectorAll("body *")].some((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const rect = element.getBoundingClientRect();
      return visible(element)
        && /^\d{2}\.\d{1,2}\.\d{1,2}\([^)]+\)$/.test(text)
        && rect.x > window.innerWidth * 0.25
        && rect.y < 120;
    });
  });

  if (!hasOpenPanel) return;

  console.log("Open slot panel detected. Closing it before date navigation.");
  await humanDelay(page, "before escape existing panel", 700, 1500);
  await page.keyboard.press("Escape");
  await humanDelay(page, "after escape existing panel", 900, 2200);
}

async function navigateToDate(page, dateValue) {
  const targetLabel = formatKoreanDateLabel(dateValue);
  const targetMonthDay = formatShortMonthDay(dateValue);

  for (let i = 0; i < 8; i += 1) {
    if (await page.getByText(targetLabel, { exact: false }).first().isVisible().catch(() => false)) {
      return targetLabel;
    }

    const visibleText = await page.locator("body").innerText({ timeout: 5_000 });
    const visibleDayHeaders = [...visibleText.matchAll(/\b\d{1,2}\.\d{1,2}\([^)]+\)/g)].map((match) => match[0]);
    const actualVisibleHeader = visibleDayHeaders.find((header) => header.startsWith(`${targetMonthDay}(`));

    if (actualVisibleHeader) {
      console.log(`Target day is visible as ${actualVisibleHeader}; no next arrow click.`);
      return actualVisibleHeader;
    }

    const currentRange = visibleText.match(/20\d{2}\.\d{1,2}\.\d{1,2}\s*~\s*\d{1,2}\.\d{1,2}/)?.[0] || "unknown";
    console.log(`Target ${targetLabel} is not visible. Click exact next-week arrow from ${currentRange}.`);
    await clickNextWeekArrow(page);
  }

  throw new Error(`Could not navigate to ${targetLabel} with next-week arrow.`);
}

async function clickNextWeekArrow(page) {
  const nextButton = page.getByRole("button", { name: TEXT.next }).first();
  await nextButton.waitFor({ state: "visible", timeout: 10_000 });
  const box = await nextButton.boundingBox();

  if (!box) {
    throw new Error("Could not locate exact next-week arrow button.");
  }

  await humanDelay(page, "before exact next-week arrow", 700, 1600);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await humanDelay(page, "after exact next-week arrow", 1000, 2200);
}

async function openDaySlotPanel(page, dateValue, targetLabel, startHour) {
  const timeText = `${String(startHour).padStart(2, "0")}:00`;
  const clickPoint = await page.evaluate(
    ({ targetLabel, timeText }) => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const elements = [...document.querySelectorAll("body *")].filter(visible);
      const dayCandidates = elements
        .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, " ").trim(), rect: element.getBoundingClientRect() }))
        .filter(({ text, rect }) => text === targetLabel && rect.y > 250 && rect.y < 450)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

      const timeCandidates = elements
        .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, " ").trim(), rect: element.getBoundingClientRect() }))
        .filter(({ text, rect }) => text === timeText && rect.x > 250 && rect.x < 380)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

      const dayRect = dayCandidates[0]?.rect;
      const timeRect = timeCandidates[0]?.rect;

      if (!dayRect || !timeRect) return null;

      return {
        x: dayRect.x + dayRect.width / 2,
        y: timeRect.y + timeRect.height / 2,
      };
    },
    { targetLabel, timeText }
  );

  if (!clickPoint) {
    throw new Error(`Could not locate exact date column ${targetLabel} and time row ${timeText}.`);
  }

  await page.mouse.click(clickPoint.x, clickPoint.y);
  await humanDelay(page, "after day slot click", 900, 2200);

  const expectedPanelTitle = formatPanelDateTitle(dateValue);
  const panelTitleVisible = await page.getByText(expectedPanelTitle, { exact: false })
    .first()
    .isVisible()
    .catch(() => false);

  if (!panelTitleVisible) {
    await saveScreenshot(page, "naver-slots-date-mismatch");
    throw new Error(
      `Opened wrong date panel. Expected ${expectedPanelTitle}. Refusing to toggle or save.`
    );
  }
}

async function clickHourToggle(page, hour, mode) {
  const label = `${String(hour).padStart(2, "0")}:00`;
  const toggle = await page.evaluate((targetLabel) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function parseRgb(color) {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return null;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
      };
    }

    function elementColorState(element) {
      const rect = element.getBoundingClientRect();
      const candidates = [element, ...element.querySelectorAll("*")]
        .map((candidate) => {
          const candidateRect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          const rgb = parseRgb(style.backgroundColor);
          return { candidate, rect: candidateRect, rgb };
        })
        .filter(({ rect: candidateRect, rgb }) => {
          if (!rgb) return false;
          if (candidateRect.width < 28 || candidateRect.width > 90) return false;
          if (candidateRect.height < 16 || candidateRect.height > 48) return false;
          const sameCenterY = Math.abs((candidateRect.y + candidateRect.height / 2) - (rect.y + rect.height / 2)) < 4;
          return sameCenterY;
        })
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

      const target = candidates[0];
      if (!target) return null;

      const { rgb } = target;
      if (rgb.g > 130 && rgb.r < 100 && rgb.b < 140) return "open";
      if (Math.abs(rgb.r - rgb.g) < 35 && Math.abs(rgb.g - rgb.b) < 35 && rgb.r > 110 && rgb.r < 230) {
        return "close";
      }

      return null;
    }

    const elements = [...document.querySelectorAll("body *")].filter(visible);
    const labels = elements
      .filter((element) => (element.textContent || "").trim() === targetLabel)
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => b.x - a.x);

    const timeRect = labels[0];
    if (!timeRect) return null;

    const rowCenterY = timeRect.y + timeRect.height / 2;
    const toggles = elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const state = elementColorState(element);
        return { element, rect, state };
      })
      .filter(({ rect, state }) => {
        const sameRow = Math.abs((rect.y + rect.height / 2) - rowCenterY) < 18;
        const rightSide = rect.x > timeRect.x + timeRect.width;
        const switchSize = rect.width >= 32 && rect.width <= 90 && rect.height >= 18 && rect.height <= 48;
        return sameRow && rightSide && switchSize && state;
      })
      .sort((a, b) => a.rect.x - b.rect.x);

    const found = toggles[0];
    if (!found) return null;

    return {
      x: found.rect.x + found.rect.width / 2,
      y: found.rect.y + found.rect.height / 2,
      state: found.state,
    };
  }, label);

  if (!toggle) {
    throw new Error(`Could not find visual toggle for ${label}.`);
  }

  const isOn = toggle.state === "open";
  const shouldBeOn = mode === "open";

  if (isOn === shouldBeOn) {
    console.log(`${label}: already ${mode}`);
    return;
  }

  await humanDelay(page, `before ${label} toggle`, 500, 1200);
  await page.mouse.click(toggle.x, toggle.y);
  await humanDelay(page, `after ${label} toggle`, 500, 1400);
  console.log(`${label}: changed to ${mode}`);
}

async function clickSlotPanelSave(page) {
  const saveText = "\uc800\uc7a5";
  const cancelText = "\ucde8\uc18c";

  const saveButton = await page.evaluateHandle(
    ({ saveText, cancelText }) => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function parseRgb(color) {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return null;
        return {
          r: Number(match[1]),
          g: Number(match[2]),
          b: Number(match[3]),
        };
      }

      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          const rgb = parseRgb(window.getComputedStyle(element).backgroundColor);
          return { element, rect, text, rgb };
        })
        .filter(({ text, rect }) => text.includes(saveText) && !text.includes(cancelText) && rect.y > window.innerHeight * 0.55);

      const greenSave = buttons.find(({ rgb }) => rgb && rgb.g > 130 && rgb.r < 80);
      return greenSave?.element || buttons.sort((a, b) => b.rect.y - a.rect.y)[0]?.element || null;
    },
    { saveText, cancelText }
  );

  const buttonElement = saveButton.asElement();
  if (!buttonElement) {
    throw new Error("Could not find slot panel save button.");
  }

  await humanDelay(page, "before save button", 900, 2200);
  await buttonElement.click();
  await humanDelay(page, "after save button", 1800, 4000);
  console.log("Slot panel saved.");
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help === "true") {
    console.log(usage());
    return;
  }

  const room = parseRoom(requiredArg(args, "room"));
  const dateValue = requiredArg(args, "date");
  const startHour = parseHour(requiredArg(args, "start"), "--start");
  const endHour = parseHour(requiredArg(args, "end"), "--end");
  const mode = args.mode || "close";
  const apply = args.apply === "true";
  const productUrl = args["product-url"] || optionalEnv(`NAVER_ROOM${room}_PRODUCT_URL`, "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("--date must be YYYY-MM-DD");
  }
  if (mode !== "close" && mode !== "open") {
    throw new Error("--mode must be close or open");
  }
  if (endHour <= startHour) {
    throw new Error("--end must be after --start");
  }
  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }
  if (!productUrl) {
    throw new Error(
      `Missing safe product edit URL. Open the product edit page manually once, copy the URL, then pass --product-url=... or set NAVER_ROOM${room}_PRODUCT_URL in .env.`
    );
  }

  const url = productUrl;
  const productName = ROOM_PRODUCT_NAMES[room];
  const browser = await launchRpaBrowser({ headless: false });
  let page;

  try {
    const context = await newRpaContext(browser, {
      storageState: naverStorageStatePath,
    });
    page = await context.newPage();

    console.log(`Open: ${url}`);
    await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await humanDelay(page, "after page open", 1200, 2800);
    await saveScreenshot(page, "naver-slots-01-product-url");

    console.log("Open schedule tab");
    await openScheduleTab(page);
    await saveScreenshot(page, "naver-slots-03-schedule");

    const targetLabel = await navigateToDate(page, dateValue);
    console.log(`Target day: ${targetLabel}`);
    await saveScreenshot(page, "naver-slots-04-target-week");

    await openDaySlotPanel(page, dateValue, targetLabel, startHour);
    await saveScreenshot(page, "naver-slots-05-slot-panel");

    if (!apply) {
      console.log("\nDry run complete. Add --apply to actually click toggles.");
      return;
    }

    for (let hour = startHour; hour < endHour; hour += 1) {
      await clickHourToggle(page, hour, mode);
    }

    await clickSlotPanelSave(page);
    await saveScreenshot(page, "naver-slots-06-after-toggle");
    console.log(`\nDone: room ${room}, ${dateValue}, ${args.start}-${args.end}, mode=${mode}`);
  } catch (error) {
    console.error("Naver slot RPA failed:", error instanceof Error ? error.message : error);
    await page?.screenshot?.({ path: `rpa/screenshots/naver-slots-error-${Date.now()}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("\n" + usage());
  process.exit(1);
});
