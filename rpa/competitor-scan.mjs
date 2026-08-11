import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { humanClickElement } from "./lib/human.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import { readFile } from "node:fs/promises";
import { saveScreenshot } from "./lib/screenshot.mjs";
import {
  clearCompetitorEvidenceViewport,
  prepareCompetitorEvidenceViewport,
} from "./lib/competitor-evidence.mjs";

const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const TRACKED_START_HOUR = 8;
const TRACKED_END_HOUR = 24;
const DATE_SELECTED = "SELECTED";
const DATE_UNAVAILABLE = "UNAVAILABLE";
const DATE_NOT_YET_OPEN = "NOT_YET_OPEN";
const CALENDAR_ASYNC_SETTLE_MS = 2_000;

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

async function captureEvidence(page, competitor, targetKey, reason) {
  try {
    const hasTargetRange = Boolean(targetKey)
      && Number.isInteger(reason.startHour)
      && Number.isInteger(reason.endHour)
      && reason.endHour > reason.startHour;
    let focus = null;
    if (hasTargetRange) {
      focus = await prepareCompetitorEvidenceViewport(page, {
        competitorName: competitor.name,
        dateKey: targetKey,
        startHour: reason.startHour,
        endHour: reason.endHour,
        reasonCode: reason.reasonCode,
      });
    }
    const imagePath = await saveScreenshot(
      page,
      `competitor-evidence-${competitor.id}-${targetKey || "page"}-${reason.reasonCode.toLowerCase()}`,
      hasTargetRange ? { fullPage: false } : {},
    );
    return {
      competitorId: competitor.id,
      dateKey: targetKey || null,
      startHour: reason.startHour ?? null,
      endHour: reason.endHour ?? null,
      reasonCode: reason.reasonCode,
      reason: reason.reason,
      imagePath,
      capturedAt: new Date().toISOString(),
      screenshotFocus: focus,
    };
  } catch (error) {
    console.error(
      `[Competitor] Evidence screenshot failed for ${competitor.id} ${targetKey || "page"}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    await clearCompetitorEvidenceViewport(page);
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
  // Calculate the weekday from calendar parts, not from the server's local
  // timezone. A KST midnight is still the previous UTC date on the server.
  const firstDay = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay();
  return firstDay + day - 1;
}

function isPolicyClosed(targetKey, hour, checkedAt, leadMinutes) {
  if (targetKey !== dateKey(checkedAt)) return false;
  const start = new Date(`${targetKey}T${String(hour).padStart(2, "0")}:00:00+09:00`);
  // Naver exposes whole-hour choices and rolls the effective current time up
  // to the next clock boundary. Mirroring that behavior prevents a same-day
  // automatic cutoff from being recorded as a competitor booking.
  const roundedCheckedAt = Math.ceil(checkedAt.getTime() / 3_600_000) * 3_600_000;
  return roundedCheckedAt >= start.getTime() - leadMinutes * 60_000;
}

async function waitForCalendar(page) {
  await page.waitForSelector(".calendar_title", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('button[data-click-code="calendar.date"]').length >= 28,
    null,
    { timeout: 30_000 },
  );
  // Naver renders the month title and disabled date buttons first, then fills
  // their real availability asynchronously. Reading immediately can turn an
  // entire future month into NOT_YET_OPEN or UNKNOWN.
  await page.waitForTimeout(CALENDAR_ASYNC_SETTLE_MS);
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
    // The title changes before the target month's date availability is ready.
    await page.waitForTimeout(CALENDAR_ASYNC_SETTLE_MS);
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
  if (await button.isDisabled()) {
    const { year, month, day } = parseDateKey(targetKey);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastTargetMonthIndex = index - day + daysInMonth;
    let hasLaterSelectableDate = false;
    for (let cursor = index + 1; cursor <= Math.min(lastTargetMonthIndex, count - 1); cursor += 1) {
      if (!await buttons.nth(cursor).isDisabled()) {
        hasLaterSelectableDate = true;
        break;
      }
    }
    // A disabled date followed by enabled dates may be fully occupied and is
    // genuinely uncertain. A disabled tail after the last enabled date is the
    // platform's not-yet-open booking horizon and must not look like a booking.
    return hasLaterSelectableDate ? DATE_UNAVAILABLE : DATE_NOT_YET_OPEN;
  }

  const targetAlreadySelected = await button.evaluate((element) => (
    element.closest(".calendar_date")?.classList.contains("selected") === true
  )).catch(() => false);

  if (!targetAlreadySelected) {
    // Selecting a date makes Naver scroll down to the time choices. Bring the
    // next calendar date back into the viewport before using coordinate-based
    // human clicking; otherwise the click can land at the top edge of the page.
    await button.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await page.waitForTimeout(200);
    await humanClickElement(page, button, `competitor calendar date ${targetKey}`);
    try {
      await page.waitForFunction(
        ({ expectedDay, targetIndex }) => {
          const targetButton = document.querySelectorAll('button[data-click-code="calendar.date"]')[targetIndex];
          const targetCell = targetButton?.closest(".calendar_date");
          const selectedDay = targetCell?.querySelector(".num")?.textContent?.trim();
          return targetCell?.classList.contains("selected") === true
            && selectedDay === String(expectedDay);
        },
        { expectedDay: day, targetIndex: index },
        { timeout: 20_000 },
      );
    } catch (error) {
      throw new Error(
        `Calendar date ${targetKey} was clicked but not selected: ${error instanceof Error ? error.message : error}`,
      );
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  }

  // The selected marker can appear before the asynchronous time list. Waiting
  // for at least one item avoids turning a still-loading list into UNKNOWN.
  await page.locator(".time_item").first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return DATE_SELECTED;
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

function buildObservations(competitor, targetKey, rawSlots, checkedAt, dateSelection = DATE_SELECTED) {
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
    } else if (dateSelection === DATE_NOT_YET_OPEN) {
      observedState = "NOT_YET_OPEN";
      reason = "BOOKING_WINDOW_NOT_OPEN";
    } else if (dateSelection === DATE_UNAVAILABLE) {
      observedState = "UNKNOWN";
      reason = "DATE_DISABLED_WITHIN_BOOKING_WINDOW";
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
      const captured = await captureEvidence(page, competitor, null, reason);
      if (captured) evidence.push(captured);
      errors.push({ competitorId: competitor.id, dateKey: null, message });
      return { observations, evidence, errors };
    }

    for (let index = 0; index < targetDates.length; index += 1) {
      const targetKey = targetDates[index];
      try {
        const dateSelection = await selectDate(page, targetKey);
        const checkedAt = new Date();
        const rawSlots = dateSelection === DATE_SELECTED ? await readVisibleSlots(page) : [];
        const dateObservations = buildObservations(
          competitor,
          targetKey,
          rawSlots,
          checkedAt,
          dateSelection,
        );
        observations.push(...dateObservations);

        const reason = detectEvidenceReason(competitor.id, targetKey, dateObservations, previousStates);
        if (reason) {
          const captured = await captureEvidence(page, competitor, targetKey, reason);
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
        const captured = await captureEvidence(page, competitor, targetKey, reason);
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
  const observations = [];
  const evidence = [];
  const errors = [];
  const releaseScanLock = await acquireProcessLock("rpa/.locks/competitor-scan.lock", {
    label: "Competitor public scan",
    failIfLocked: true,
    staleMs: 15 * 60 * 1000,
  });

  try {
    const browser = await launchRpaBrowser({
      headless: !headed,
      // Public pages still use the dedicated ISP proxy so competitor traffic
      // never exposes the server's own address. forceProxy forbids a silent
      // direct-IP fallback when configuration or balance checks change.
      useProxy: true,
      forceProxy: true,
      // Competitor pages are public. Never inherit the persistent context that
      // contains Naver and SpaceCloud administrator login cookies.
      reuse: false,
    });
    try {
      const context = await newRpaContext(browser, {
        blockHeavyResources: true,
        rpaRole: "competitor",
      });
      try {
        const inheritedCookies = await context.cookies();
        if (inheritedCookies.length > 0) {
          throw new Error("Competitor browser inherited cookies before public navigation");
        }

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
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await releaseScanLock();
  }

  console.log(`${RESULT_PREFIX}${JSON.stringify({ startKey, endKey, observations, evidence, errors })}`);
}

main().catch((error) => {
  console.error("Competitor scan failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
