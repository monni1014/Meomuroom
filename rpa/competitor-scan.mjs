import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs } from "./lib/cli.mjs";

const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const TRACKED_START_HOUR = 8;
const TRACKED_END_HOUR = 24;

function environmentMinutes(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const COMPETITORS = [
  {
    id: "synergy",
    name: "시너지",
    url: "https://m.booking.naver.com/booking/10/bizes/1018820/items/5442967",
    // Naver closes hourly choices on a rounded boundary. A nominal one-hour
    // cutoff can therefore make the next two clock-hour cells look booked.
    leadMinutes: environmentMinutes("COMPETITOR_SYNERGY_LEAD_MINUTES", 120),
    operatingStartHour: 6,
    operatingEndHour: 24,
  },
  {
    id: "triground-a",
    name: "트라이그라운드 A",
    url: "https://m.booking.naver.com/booking/10/bizes/1525433/items/7149514",
    leadMinutes: environmentMinutes("COMPETITOR_TRIGROUND_LEAD_MINUTES", 0),
    operatingStartHour: 8,
    operatingEndHour: 22,
  },
  {
    id: "triground-b",
    name: "트라이그라운드 B",
    url: "https://m.booking.naver.com/booking/10/bizes/1525433/items/7216191",
    leadMinutes: environmentMinutes("COMPETITOR_TRIGROUND_LEAD_MINUTES", 0),
    operatingStartHour: 8,
    operatingEndHour: 22,
  },
];

function requiredDateKey(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is invalid`);
  return value;
}

function parseDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function dateKey(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function datesBetween(startKey, endKey) {
  const result = [];
  const cursor = new Date(`${startKey}T00:00:00+09:00`);
  const end = new Date(`${endKey}T00:00:00+09:00`);
  while (cursor <= end) {
    result.push(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function monthIndex(year, month) {
  return year * 12 + month - 1;
}

function targetCalendarIndex(targetKey) {
  const { year, month, day } = parseDateKey(targetKey);
  const firstDay = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+09:00`).getDay();
  return firstDay + day - 1;
}

function isPolicyClosed(targetKey, hour, checkedAt, leadMinutes) {
  if (targetKey !== dateKey(checkedAt)) return false;
  const start = new Date(`${targetKey}T${String(hour).padStart(2, "0")}:00:00+09:00`);
  return checkedAt.getTime() >= start.getTime() - leadMinutes * 60_000;
}

async function waitForCalendar(page) {
  await page.waitForSelector(".calendar_title", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('button[data-click-code="calendar.date"]').length >= 28,
    null,
    { timeout: 30_000 },
  );
}

async function visibleMonth(page) {
  const text = await page.locator(".calendar_title").innerText({ timeout: 10_000 });
  const match = text.match(/(20\d{2})\.(\d{1,2})/);
  if (!match) throw new Error(`Could not read visible month: ${text}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

async function navigateToMonth(page, targetKey) {
  const target = parseDateKey(targetKey);
  const targetValue = monthIndex(target.year, target.month);

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const current = await visibleMonth(page);
    const currentValue = monthIndex(current.year, current.month);
    if (currentValue === targetValue) return;

    const direction = targetValue > currentValue ? "nextmonth" : "prevmonth";
    const button = page.locator(`button[data-click-code="calendar.${direction}"]`);
    if (await button.isDisabled()) {
      throw new Error(`Calendar cannot move to ${target.year}.${target.month}`);
    }
    await button.click();
    await page.waitForFunction(
      ({ year, month }) => {
        const text = document.querySelector(".calendar_title")?.textContent || "";
        return text.includes(`${year}.${month}`);
      },
      target,
      { timeout: 15_000 },
    );
  }

  throw new Error(`Could not navigate calendar to ${target.year}.${target.month}`);
}

async function selectDate(page, targetKey) {
  await navigateToMonth(page, targetKey);
  const { day } = parseDateKey(targetKey);
  const index = targetCalendarIndex(targetKey);
  const buttons = page.locator('button[data-click-code="calendar.date"]');
  const count = await buttons.count();
  if (index < 0 || index >= count) {
    throw new Error(`Calendar index ${index} is outside ${count} date buttons for ${targetKey}`);
  }

  const button = buttons.nth(index);
  if (await button.isDisabled()) return false;

  await button.click();
  await page.waitForFunction(
    ({ expectedDay }) => {
      const selected = document.querySelector(".calendar_date.selected .num")?.textContent?.trim();
      return selected === String(expectedDay);
    },
    { expectedDay: day },
    { timeout: 20_000 },
  );
  await page.waitForTimeout(250);
  return true;
}

async function readVisibleSlots(page) {
  return page.evaluate(() => {
    let period = "AM";
    return [...document.querySelectorAll(".time_item")].map((element) => {
      const text = (element.querySelector(".time_text")?.textContent || "").replace(/\s+/g, "").trim();
      if (text.includes("오전")) period = "AM";
      if (text.includes("오후")) period = "PM";
      const match = text.match(/(\d{1,2})시/);
      if (!match) return null;
      let hour = Number(match[1]);
      if (period === "PM" && hour !== 12) hour += 12;
      if (period === "AM" && hour === 12) hour = 0;
      return {
        hour,
        unavailable: element.classList.contains("disabled"),
        className: element.className,
      };
    }).filter(Boolean);
  });
}

function buildObservations(competitor, targetKey, rawSlots, checkedAt) {
  const rawByHour = new Map(rawSlots.map((slot) => [slot.hour, slot]));
  const observations = [];

  for (let hour = TRACKED_START_HOUR; hour < TRACKED_END_HOUR; hour += 1) {
    const raw = rawByHour.get(hour);
    const offered = hour >= competitor.operatingStartHour && hour < competitor.operatingEndHour;
    const policyClosed = offered && isPolicyClosed(targetKey, hour, checkedAt, competitor.leadMinutes);

    let observedState = "UNKNOWN";
    let reason = null;
    if (!offered) {
      observedState = "NOT_OFFERED";
      reason = "OUTSIDE_OPERATING_HOURS";
    } else if (raw && !raw.unavailable) {
      observedState = "AVAILABLE";
    } else if (policyClosed) {
      observedState = "POLICY_CLOSED";
      reason = `BOOKING_CUTOFF_${competitor.leadMinutes}_MINUTES`;
    } else if (raw?.unavailable) {
      observedState = "BOOKED";
    } else {
      observedState = "UNKNOWN";
      reason = "SLOT_NOT_RENDERED";
    }

    observations.push({
      competitorId: competitor.id,
      dateKey: targetKey,
      hour,
      observedState,
      reason,
      checkedAt: checkedAt.toISOString(),
    });
  }

  return observations;
}

async function scanCompetitor(context, competitor, targetDates) {
  const page = await context.newPage();
  const observations = [];

  try {
    await page.goto(competitor.url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await waitForCalendar(page);

    for (const targetKey of targetDates) {
      const selectable = await selectDate(page, targetKey);
      const checkedAt = new Date();
      const rawSlots = selectable ? await readVisibleSlots(page) : [];
      observations.push(...buildObservations(competitor, targetKey, rawSlots, checkedAt));
    }

    return observations;
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const startKey = requiredDateKey(args.start, "--start");
  const endKey = requiredDateKey(args.end, "--end");
  if (startKey > endKey) throw new Error("--start must not be after --end");

  const requestedIds = args.competitor
    ? new Set(String(args.competitor).split(",").map((value) => value.trim()).filter(Boolean))
    : null;
  const competitors = requestedIds
    ? COMPETITORS.filter((competitor) => requestedIds.has(competitor.id))
    : COMPETITORS;
  if (competitors.length === 0) throw new Error("No matching competitors were selected");

  const targetDates = datesBetween(startKey, endKey);
  const browser = await launchRpaBrowser({ headless: true, useProxy: false });
  const observations = [];
  const errors = [];

  try {
    const context = await newRpaContext(browser, { blockHeavyResources: true });
    for (const competitor of competitors) {
      try {
        observations.push(...await scanCompetitor(context, competitor, targetDates));
      } catch (error) {
        errors.push({
          competitorId: competitor.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`${RESULT_PREFIX}${JSON.stringify({ startKey, endKey, observations, errors })}`);
}

main().catch((error) => {
  console.error("Competitor scan failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
