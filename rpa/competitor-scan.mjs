import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { humanClickElement } from "./lib/human.mjs";
import { readFile } from "node:fs/promises";
import { saveScreenshot } from "./lib/screenshot.mjs";

const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const TRACKED_START_HOUR = 8;
const TRACKED_END_HOUR = 24;

function previousStateKey(competitorId, targetKey, hour) {
  return `${competitorId}|${targetKey}|${hour}`;
}

async function loadPreviousStates(filePath) {
  if (!filePath) return new Map();
  const rows = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(rows)) throw new Error("Previous competitor states must be an array");
  return new Map(rows.map((row) => [
    previousStateKey(row.competitorId, row.dateKey, row.hour),
    { state: row.state, pendingState: row.pendingState || null },
  ]));
}

function evidenceRange(hours) {
  if (hours.length === 0) return { startHour: null, endHour: null };
  return {
    startHour: Math.min(...hours),
    endHour: Math.max(...hours) + 1,
  };
}

function detectEvidenceReason(competitorId, targetKey, observations, previousStates) {
  const unknownHours = observations
    .filter((observation) => observation.observedState === "UNKNOWN")
    .map((observation) => observation.hour);
  if (unknownHours.length > 0) {
    return {
      reasonCode: "SLOT_READ_UNCERTAIN",
      reason: "One or more time slots could not be read from the public booking page.",
      ...evidenceRange(unknownHours),
    };
  }

  const cutoffBlockedHours = observations
    .filter((observation) => {
      const previous = previousStates.get(previousStateKey(competitorId, targetKey, observation.hour));
      return previous?.state === "BOOKED"
        && previous.pendingState === "AVAILABLE"
        && observation.observedState === "POLICY_CLOSED";
    })
    .map((observation) => observation.hour);
  if (cutoffBlockedHours.length > 0) {
    return {
      reasonCode: "CUTOFF_BLOCKED_CONFIRMATION",
      reason: "The booking cutoff hid a slot while a cancellation confirmation was pending.",
      ...evidenceRange(cutoffBlockedHours),
    };
  }

  const cancellationHours = observations
    .filter((observation) => {
      const previous = previousStates.get(previousStateKey(competitorId, targetKey, observation.hour));
      return previous?.state === "BOOKED" && observation.observedState === "AVAILABLE";
    })
    .map((observation) => observation.hour);
  if (cancellationHours.length > 0) {
    return {
      reasonCode: "CANCELLATION_PENDING_CONFIRMATION",
      reason: "A previously booked slot appeared available and needs a second scan for confirmation.",
      ...evidenceRange(cancellationHours),
    };
  }

  return null;
}

async function captureEvidence(page, competitorId, targetKey, reason) {
  try {
    const imagePath = await saveScreenshot(
      page,
      `competitor-evidence-${competitorId}-${targetKey || "page"}-${reason.reasonCode.toLowerCase()}`,
    );
    return {
      competitorId,
      dateKey: targetKey || null,
      startHour: reason.startHour ?? null,
      endHour: reason.endHour ?? null,
      reasonCode: reason.reasonCode,
      reason: reason.reason,
      imagePath,
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error(
      `[Competitor] Evidence screenshot failed for ${competitorId} ${targetKey || "page"}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

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
    await humanClickElement(page, button, `competitor calendar ${direction}`);
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

  // Selecting a date makes Naver scroll down to the time choices. Bring the
  // next calendar date back into the viewport before using coordinate-based
  // human clicking; otherwise the click can land at the top edge of the page.
  await button.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await humanClickElement(page, button, `competitor calendar date ${targetKey}`);
  try {
    await page.waitForFunction(
      ({ expectedDay }) => {
        const selected = document.querySelector(".calendar_date.selected .num")?.textContent?.trim();
        return selected === String(expectedDay);
      },
      { expectedDay: day },
      { timeout: 20_000 },
    );
  } catch (error) {
    throw new Error(
      `Calendar date ${targetKey} was clicked but not selected: ${error instanceof Error ? error.message : error}`,
    );
  }
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

async function scanCompetitor(context, competitor, targetDates, previousStates, demoHoldMs = 0) {
  const page = await context.newPage();
  const observations = [];
  const evidence = [];
  const errors = [];

  const openCompetitorPage = async () => {
    await page.goto(competitor.url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await waitForCalendar(page);
  };

  try {
    try {
      await openCompetitorPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = {
        reasonCode: "COMPETITOR_PAGE_ERROR",
        reason: `The competitor booking page could not be opened or read: ${message}`,
        startHour: null,
        endHour: null,
      };
      const captured = await captureEvidence(page, competitor.id, null, reason);
      if (captured) evidence.push(captured);
      errors.push({ competitorId: competitor.id, dateKey: null, message });
      return { observations, evidence, errors };
    }

    for (let index = 0; index < targetDates.length; index += 1) {
      const targetKey = targetDates[index];
      try {
        const selectable = await selectDate(page, targetKey);
        const checkedAt = new Date();
        const rawSlots = selectable ? await readVisibleSlots(page) : [];
        const dateObservations = buildObservations(competitor, targetKey, rawSlots, checkedAt);
        observations.push(...dateObservations);

        const reason = detectEvidenceReason(competitor.id, targetKey, dateObservations, previousStates);
        if (reason) {
          const captured = await captureEvidence(page, competitor.id, targetKey, reason);
          if (captured) evidence.push(captured);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = {
          reasonCode: "DATE_SCAN_ERROR",
          reason: `The requested date or its time slots could not be read: ${message}`,
          startHour: null,
          endHour: null,
        };
        const captured = await captureEvidence(page, competitor.id, targetKey, reason);
        if (captured) evidence.push(captured);
        errors.push({ competitorId: competitor.id, dateKey: targetKey, message });

        if (index < targetDates.length - 1) {
          try {
            await openCompetitorPage();
          } catch (recoveryError) {
            errors.push({
              competitorId: competitor.id,
              dateKey: targetDates[index + 1],
              message: `Page recovery failed: ${recoveryError instanceof Error ? recoveryError.message : recoveryError}`,
            });
            break;
          }
        }
      }
    }

    if (demoHoldMs > 0) await page.waitForTimeout(demoHoldMs);

    return { observations, evidence, errors };
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const headed = args.headed === "true";
  const demoHoldMs = headed ? Math.max(0, Number(args["hold-ms"] || 5_000)) : 0;
  if (args["show-mouse"] === "true") process.env.RPA_SHOW_MOUSE_CURSOR = "true";
  const startKey = requiredDateKey(args.start, "--start");
  const endKey = requiredDateKey(args.end, "--end");
  if (startKey > endKey) throw new Error("--start must not be after --end");
  const previousStates = await loadPreviousStates(args["previous-states"]);

  const requestedIds = args.competitor
    ? new Set(String(args.competitor).split(",").map((value) => value.trim()).filter(Boolean))
    : null;
  const competitors = requestedIds
    ? COMPETITORS.filter((competitor) => requestedIds.has(competitor.id))
    : COMPETITORS;
  if (competitors.length === 0) throw new Error("No matching competitors were selected");

  const targetDates = datesBetween(startKey, endKey);
  const browser = await launchRpaBrowser({
    headless: !headed,
    useProxy: false,
    reuse: !headed,
  });
  const observations = [];
  const evidence = [];
  const errors = [];

  try {
    const context = await newRpaContext(browser, {
      blockHeavyResources: true,
      rpaRole: "competitor",
    });
    for (const competitor of competitors) {
      try {
        const scanned = await scanCompetitor(
          context,
          competitor,
          targetDates,
          previousStates,
          demoHoldMs,
        );
        observations.push(...scanned.observations);
        evidence.push(...scanned.evidence);
        errors.push(...scanned.errors);
      } catch (error) {
        errors.push({
          competitorId: competitor.id,
          dateKey: null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`${RESULT_PREFIX}${JSON.stringify({ startKey, endKey, observations, evidence, errors })}`);
}

main().catch((error) => {
  console.error("Competitor scan failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
