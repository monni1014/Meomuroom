import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs, parseHour, parseRoom, requiredArg } from "./lib/cli.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { humanClick, humanClickElement, humanDelay } from "./lib/human.mjs";
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

function toKstDateOnlyMs(dateValue) {
  return new Date(`${dateValue}T00:00:00+09:00`).getTime();
}

function parseVisibleWeekRange(text) {
  const match = text.match(/(20\d{2})\.(\d{1,2})\.(\d{1,2})\s*~\s*(?:(20\d{2})\.)?(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;

  const startYear = Number(match[1]);
  const startMonth = Number(match[2]);
  const startDay = Number(match[3]);
  const endMonth = Number(match[5]);
  const endDay = Number(match[6]);
  const endYear = match[4]
    ? Number(match[4])
    : startYear + (endMonth < startMonth ? 1 : 0);

  const startValue = `${startYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
  const endValue = `${endYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;

  return {
    label: match[0],
    startMs: toKstDateOnlyMs(startValue),
    endMs: toKstDateOnlyMs(endValue),
  };
}

async function clickTextIfVisible(page, text, timeout = 15_000) {
  const locator = page.getByText(text, { exact: false }).first();
  await locator.waitFor({ state: "visible", timeout });
  await humanDelay(page, "before text click", 700, 1700);
  await humanClickElement(page, locator, `click ${text}`);
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
  const targetMs = toKstDateOnlyMs(dateValue);

  await page.waitForFunction(() => /20\d{2}\.\d{1,2}\.\d{1,2}\s*~/.test(document.body?.innerText || ""), null, {
    timeout: 30_000,
  });

  for (let i = 0; i < 12; i += 1) {
    const visibleText = await page.locator("body").innerText({ timeout: 5_000 });
    const visibleDayHeaders = [...visibleText.matchAll(/\b\d{1,2}\.\d{1,2}\s*\([^)]+\)/g)]
      .map((match) => match[0].replace(/\s+/g, ""));
    const actualVisibleHeader = visibleDayHeaders.find((header) => header.startsWith(`${targetMonthDay}(`));

    if (actualVisibleHeader) {
      console.log(`Target day is visible as ${actualVisibleHeader}; no week arrow click.`);
      return actualVisibleHeader;
    }

    const currentRange = parseVisibleWeekRange(visibleText);
    if (!currentRange) {
      console.log(`Target ${targetLabel} is not visible, but current week range is not loaded yet. Wait before moving.`);
      await humanDelay(page, "wait for week range", 1000, 2200);
      continue;
    }

    if (targetMs >= currentRange.startMs && targetMs <= currentRange.endMs) {
      throw new Error(
        `Target ${targetLabel} is inside visible week ${currentRange.label}, but the day header was not found. Refusing to move weeks.`
      );
    }

    const direction = targetMs < currentRange.startMs ? "previous" : "next";
    console.log(`Target ${targetLabel} is not visible. Click ${direction}-week arrow from ${currentRange.label}.`);
    await clickWeekArrow(page, direction);
  }

  throw new Error(`Could not navigate to ${targetLabel} with week arrows.`);
}

async function clickWeekArrow(page, direction) {
  const box = await page.evaluate((targetDirection) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("button,[role='button']")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          aria: element.getAttribute("aria-label") || "",
        };
      })
      .filter((candidate) =>
        candidate.x > 240
        && candidate.x < 980
        && candidate.y > 170
        && candidate.y < 360
        && candidate.width <= 90
        && candidate.height <= 90
      )
      .sort((a, b) => a.x - b.x);

    if (candidates.length === 0) return null;
    return targetDirection === "previous" ? candidates[0] : candidates[candidates.length - 1];
  }, direction);

  const fallbackLocator = direction === "next"
    ? page.getByRole("button", { name: TEXT.next }).first()
    : page.getByRole("button", { name: /이전|전일|어제/ }).first();

  const fallbackBox = box ? null : await fallbackLocator.boundingBox().catch(() => null);
  const targetBox = box || fallbackBox;

  if (!targetBox) {
    throw new Error(`Could not locate exact ${direction}-week arrow button.`);
  }

  await humanDelay(page, `before exact ${direction}-week arrow`, 700, 1600);
  await humanClick(page, targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, `${direction}-week arrow`);
  await humanDelay(page, `after exact ${direction}-week arrow`, 1000, 2200);
}

async function openDaySlotPanel(page, dateValue, targetLabel, startHour, endHour) {
  const startTimeText = `${String(startHour).padStart(2, "0")}:00`;
  const endTimeText = `${String(Math.max(startHour, endHour - 1)).padStart(2, "0")}:00`;

  const dayColumn = await page.evaluate((targetLabel) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => ({
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter(({ text, rect }) =>
        /^\d{1,2}\.\d{1,2}\([^)]+\)$/.test(text)
        && rect.y > 300
        && rect.y < 390
        && rect.x > 300
        && rect.x < 950
        && rect.width < 120
      )
      .sort((a, b) => a.rect.x - b.rect.x);

    const found = candidates.find((candidate) => candidate.text === targetLabel);
    return found
      ? {
          x: found.rect.x + found.rect.width / 2,
          labels: candidates.map((candidate) => ({
            text: candidate.text,
            x: Math.round(candidate.rect.x + candidate.rect.width / 2),
          })),
        }
      : null;
  }, targetLabel);

  if (!dayColumn) {
    throw new Error(`Could not locate target date column ${targetLabel}.`);
  }
  const dayCenterX = dayColumn.x;
  console.log(`Date columns: ${dayColumn.labels.map((label) => `${label.text}@${label.x}`).join(", ")}`);
  console.log(`Target date column ${targetLabel}: x=${Math.round(dayCenterX)}`);

  async function scrollTimeRowIntoView(timeText) {
    const scrolled = await page.evaluate((targetLabel) => {
      const candidates = [...document.querySelectorAll("body *")]
        .map((element) => ({
          element,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          rect: element.getBoundingClientRect(),
        }))
        .filter(({ text, rect }) => text === targetLabel && rect.x > 250 && rect.x < 380)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

      const target = candidates[0]?.element;
      if (!target) return false;

      target.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    }, timeText);

    if (scrolled) {
      await humanDelay(page, `after scroll to ${timeText}`, 600, 1400);
    }
  }

  async function findClickPoint(timeText, useBlockCenter = false) {
    return page.evaluate(
      ({ targetLabel, timeText, startTimeText, endTimeText, useBlockCenter, dayCenterX }) => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const elements = [...document.querySelectorAll("body *")].filter(visible);
      const timeCandidates = elements
        .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, " ").trim(), rect: element.getBoundingClientRect() }))
        .filter(({ text, rect }) => text === timeText && rect.x > 250 && rect.x < 380)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

      const timeRect = timeCandidates[0]?.rect;

      if (!timeRect) return null;
      if (timeRect.y < 0 || timeRect.y > window.innerHeight) return null;

      if (useBlockCenter) {
        const startRect = elements
          .map((element) => ({ text: (element.textContent || "").replace(/\s+/g, " ").trim(), rect: element.getBoundingClientRect() }))
          .filter(({ text, rect }) => text === startTimeText && rect.x > 250 && rect.x < 380)
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.rect;
        const endRect = elements
          .map((element) => ({ text: (element.textContent || "").replace(/\s+/g, " ").trim(), rect: element.getBoundingClientRect() }))
          .filter(({ text, rect }) => text === endTimeText && rect.x > 250 && rect.x < 380)
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.rect;

        if (startRect && endRect) {
          return {
            x: dayCenterX,
            y: ((startRect.y + startRect.height / 2) + (endRect.y + endRect.height / 2)) / 2,
          };
        }
      }

      return {
        x: dayCenterX,
        y: timeRect.y + timeRect.height / 2,
      };
    },
      { targetLabel, timeText, startTimeText, endTimeText, useBlockCenter, dayCenterX }
    );
  }

  const expectedPanelTitle = formatPanelDateTitle(dateValue);

  for (const attempt of [
    { timeText: startTimeText, useBlockCenter: false },
    { timeText: endTimeText, useBlockCenter: false },
    { timeText: startTimeText, useBlockCenter: true },
  ]) {
    await scrollTimeRowIntoView(attempt.timeText);
    const clickPoint = await findClickPoint(attempt.timeText, attempt.useBlockCenter);
    if (!clickPoint) continue;

    await humanClick(page, clickPoint.x, clickPoint.y, `open ${targetLabel} slot panel`);
    await humanDelay(page, "after day slot click", 900, 2200);

    const panelTitleVisible = await page.getByText(expectedPanelTitle, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);

    if (panelTitleVisible) {
      return;
    }

    await page.keyboard.press("Escape");
    await humanDelay(page, "after failed panel attempt escape", 500, 1100);
  }

  await saveScreenshot(page, "naver-slots-date-mismatch");
  throw new Error(
    `Opened wrong date panel. Expected ${expectedPanelTitle}. Refusing to toggle or save.`
  );
}

async function clickHourToggle(page, hour, mode) {
  const label = `${String(hour).padStart(2, "0")}:00`;
  const scrolled = await page.evaluate((targetLabel) => {
    const candidates = [...document.querySelectorAll("body *")]
      .map((element) => ({
        element,
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter(({ text, rect }) =>
        text === targetLabel
        && rect.x > window.innerWidth * 0.35
        && rect.x < window.innerWidth * 0.9
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

    const target = candidates[0]?.element;
    if (!target) return false;

    target.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }, label);

  if (scrolled) {
    await humanDelay(page, `after panel scroll to ${label}`, 350, 900);
  }

  const toggle = await page.evaluate((targetLabel) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0
        && rect.y >= 0
        && rect.y <= window.innerHeight;
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
      .filter((rect) => rect.x > window.innerWidth * 0.35 && rect.x < window.innerWidth * 0.9)
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

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
  await humanClick(page, toggle.x, toggle.y, `${label} toggle`);
  await humanDelay(page, `after ${label} toggle`, 500, 1400);
  console.log(`${label}: changed to ${mode}`);
}

async function assertHourToggleState(page, hour, mode) {
  const label = `${String(hour).padStart(2, "0")}:00`;
  let actualState = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    actualState = await page.evaluate((targetLabel) => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0
          && rect.y >= 0
          && rect.y <= window.innerHeight;
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
            return { rect: candidateRect, rgb };
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
        .filter((rect) => rect.x > window.innerWidth * 0.35 && rect.x < window.innerWidth * 0.9)
        .sort((a, b) => (a.width * a.height) - (b.width * b.height));

      const timeRect = labels[0];
      if (!timeRect) return null;

      const rowCenterY = timeRect.y + timeRect.height / 2;
      const toggles = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const state = elementColorState(element);
          return { rect, state };
        })
        .filter(({ rect, state }) => {
          const sameRow = Math.abs((rect.y + rect.height / 2) - rowCenterY) < 18;
          const rightSide = rect.x > timeRect.x + timeRect.width;
          const switchSize = rect.width >= 32 && rect.width <= 90 && rect.height >= 18 && rect.height <= 48;
          return sameRow && rightSide && switchSize && state;
        })
        .sort((a, b) => a.rect.x - b.rect.x);

      return toggles[0]?.state || null;
    }, label);

    if (actualState === mode) return;
    await humanDelay(page, `wait for ${label} ${mode} state`, 350, 800);
  }

  if (actualState !== mode) {
    throw new Error(`Unsafe save blocked: ${label} is ${actualState || "unknown"}, expected ${mode}.`);
  }
}

async function assertSlotPanelState(page, startHour, endHour, mode) {
  for (let hour = startHour; hour < endHour; hour += 1) {
    await clickHourToggle(page, hour, mode);
    await assertHourToggleState(page, hour, mode);
  }
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
  await humanClickElement(page, buttonElement, "slot panel save");
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

    await openDaySlotPanel(page, dateValue, targetLabel, startHour, endHour);
    await saveScreenshot(page, "naver-slots-05-slot-panel");

    if (!apply) {
      console.log("\nDry run complete. Add --apply to actually click toggles.");
      return;
    }

    await assertSlotPanelState(page, startHour, endHour, mode);

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
