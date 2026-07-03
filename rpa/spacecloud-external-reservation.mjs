import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { parseArgs, parseHour, parseRoom, requiredArg } from "./lib/cli.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { humanClick, humanClickElement, humanDelay } from "./lib/human.mjs";
import { spaceCloudStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const TEXT = {
  hostLogout: "\ud638\uc2a4\ud2b8 \ub85c\uadf8\uc544\uc6c3",
  login: "\ub85c\uadf8\uc778",
  reservationCalendar: "\uc608\uc57d/\uce98\ub9b0\ub354",
  reservationList: "\uc608\uc57d \uad00\ub9ac \ub9ac\uc2a4\ud2b8",
  calendarView: "\uce98\ub9b0\ub354 \ubcf4\uae30",
  addReservation: "\uc608\uc57d\ucd94\uac00",
  directAdded: "\uc9c1\uc811 \ucd94\uac00\ud55c \uc608\uc57d \uac74\uc785\ub2c8\ub2e4.",
  deleteReservation: "\uc608\uc57d \uc0ad\uc81c",
  confirm: "\ud655\uc778",
  cancel: "\ucde8\uc18c",
  fullDay: "\uc885\uc77c",
  noRepeat: "\ubc18\ubcf5\uc548\ud568",
  room1: "\uba38\ubb34\ub8f8 \ud68c\uc758\uc2e4 \uc608\uc57d\ud558\uae30 1",
  room2: "\uba38\ubb34\ub8f8 \ud68c\uc758\uc2e4 \uc608\uc57d\ud558\uae30 2",
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
  "1": TEXT.room1,
  "2": TEXT.room2,
};

function usage() {
  return [
    "Usage:",
    "  npm run rpa:spacecloud-external -- --room=1 --date=2026-07-03 --start=11:00 --end=15:00 --mode=close --booking-number=123 --apply",
    "",
    "Options:",
    "  --room=1|2",
    "  --date=YYYY-MM-DD",
    "  --start=HH:00",
    "  --end=HH:00",
    "  --mode=close|open",
    "  --booking-number=NaverBookingNumber",
    "  --customer-name=Name  optional, used as SpaceCloud external reservation name",
    "  --phone=010-0000-0000 optional, used as SpaceCloud external reservation contact",
    "  --apply       actually add/delete the SpaceCloud external reservation.",
  ].join("\n");
}

function markerForBooking(bookingNumber) {
  return `네이버 예약번호: ${bookingNumber}`;
}

function parseDateValue(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) throw new Error("--date must be YYYY-MM-DD");

  const date = new Date(`${dateValue}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error("--date is invalid");

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    date,
  };
}

function monthKey(dateValue) {
  const { year, month } = parseDateValue(dateValue);
  return `${year}.${month}`;
}

function formatModalDate(dateValue) {
  const { year, month, day, date } = parseDateValue(dateValue);
  return `${year}. ${String(month).padStart(2, "0")}. ${String(day).padStart(2, "0")} (${WEEKDAYS[date.getDay()]})`;
}

function formatDetailDate(dateValue) {
  const { year, month, day, date } = parseDateValue(dateValue);
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}(${WEEKDAYS[date.getDay()]})`;
}

function formatLooseDetailDate(dateValue) {
  const { year, month, day, date } = parseDateValue(dateValue);
  return `${year}.${month}.${day}(${WEEKDAYS[date.getDay()]})`;
}

function hourLabel(hour) {
  return `${hour}\uc2dc`;
}

function shortTimeLabel(startHour, endHour) {
  return `\ucd94 ${startHour}~${endHour}`;
}

function parseVisibleMonth(text) {
  const matches = [...text.matchAll(/\b(20\d{2})\.(\d{1,2})\b/g)];
  const match = matches.find((item) => {
    const year = Number(item[1]);
    const month = Number(item[2]);
    return year >= 2024 && year <= 2035 && month >= 1 && month <= 12;
  });

  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    key: `${Number(match[1])}.${Number(match[2])}`,
  };
}

function monthIndex(year, month) {
  return year * 12 + month;
}

async function assertLoggedIn(page) {
  const text = await page.locator("body").innerText({ timeout: 15_000 }).catch(() => "");
  const url = page.url();

  if (/kauth\.kakao\.com|accounts\.kakao\.com|login/i.test(url)) {
    throw new Error("SpaceCloud login required. Saved session opened a login page.");
  }

  if (text.includes(TEXT.login) && !text.includes(TEXT.hostLogout) && !text.includes(TEXT.reservationList)) {
    throw new Error("SpaceCloud login required. Host center session is missing or expired.");
  }
}

async function clickVisibleText(page, text, timeout = 20_000) {
  await page.waitForFunction(
    (targetText) => {
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

      return [...document.querySelectorAll("button,a,[role='button'],span,div")]
        .some((element) => visible(element) && (element.textContent || "").replace(/\s+/g, " ").trim().includes(targetText));
    },
    text,
    { timeout },
  );

  const box = await page.evaluate((targetText) => {
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

    const candidates = [...document.querySelectorAll("button,a,[role='button'],span,div")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.text.includes(targetText)
        && candidate.width >= 12
        && candidate.height >= 12
        && candidate.width < window.innerWidth * 0.9
        && candidate.height < window.innerHeight * 0.4
      )
      .sort((a, b) => {
        const aExact = a.text === targetText ? 0 : 1;
        const bExact = b.text === targetText ? 0 : 1;
        return aExact - bExact || (a.width * a.height) - (b.width * b.height);
      });

    return candidates[0] || null;
  }, text);

  if (!box) throw new Error(`Could not find visible SpaceCloud text: ${text}`);

  await humanDelay(page, `before click ${text}`, 900, 2200);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, `click ${text}`);
  await humanDelay(page, `after click ${text}`, 1200, 2600);
}

async function clickTopRightMenu(page) {
  const box = await page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("button,a,[role='button'],div")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.x > window.innerWidth * 0.86
        && candidate.y < 130
        && candidate.width >= 24
        && candidate.width <= 110
        && candidate.height >= 24
        && candidate.height <= 100
        && !candidate.text.includes("\ub85c\uadf8\uc544\uc6c3")
      )
      .sort((a, b) => b.x - a.x || a.y - b.y);

    return candidates[0] || null;
  });

  if (!box) throw new Error("Could not find SpaceCloud host menu button.");

  await humanDelay(page, "before SpaceCloud menu click", 900, 2200);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, "SpaceCloud menu");
  await humanDelay(page, "after SpaceCloud menu click", 1400, 3200);
}

async function openReservationList(page) {
  const listUrl = optionalEnv("SPACECLOUD_RESERVATION_LIST_URL", "https://partner.spacecloud.kr/reservation/");
  const hostUrl = optionalEnv("SPACECLOUD_HOST_HOME_URL", "https://partner.spacecloud.kr/");
  const directListUrls = [...new Set([
    listUrl,
    listUrl.endsWith("/") ? listUrl.slice(0, -1) : `${listUrl}/`,
    "https://partner.spacecloud.kr/reservation/",
    "https://partner.spacecloud.kr/reservation",
  ])];

  for (const url of directListUrls) {
    console.log(`Open SpaceCloud host page: ${url}`);
    await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await humanDelay(page, "after SpaceCloud page open", 2200, 5200);
    await assertLoggedIn(page);

    const ready = await page.waitForFunction(
      ({ reservationList, calendarView }) => {
        const text = document.body?.innerText || "";
        return text.includes(reservationList) || text.includes(calendarView);
      },
      { reservationList: TEXT.reservationList, calendarView: TEXT.calendarView },
      { timeout: 35_000 },
    ).then(() => true).catch(() => false);

    if (ready) return;
  }

  console.log(`Open SpaceCloud host page: ${hostUrl}`);
  await page.goto(hostUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await humanDelay(page, "after SpaceCloud host home open", 2200, 5200);
  await assertLoggedIn(page);

  await clickTopRightMenu(page);
  await clickVisibleText(page, TEXT.reservationCalendar, 20_000);

  await page.waitForFunction(
    ({ reservationList, calendarView }) => {
      const text = document.body?.innerText || "";
      return text.includes(reservationList) || text.includes(calendarView);
    },
    { reservationList: TEXT.reservationList, calendarView: TEXT.calendarView },
    { timeout: 30_000 },
  );
}

async function openCalendarView(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (bodyText.includes(TEXT.calendarView)) {
    await clickVisibleText(page, TEXT.calendarView, 20_000);
  }

  await page.waitForFunction(() => /\b20\d{2}\.\d{1,2}\b/.test(document.body?.innerText || ""), null, {
    timeout: 30_000,
  });
  await humanDelay(page, "after SpaceCloud calendar view open", 1600, 3600);
}

async function selectNativeSelectOption(page, optionText) {
  return page.evaluate((targetText) => {
    for (const select of [...document.querySelectorAll("select")]) {
      const option = [...select.options].find((item) => (item.textContent || "").trim().includes(targetText));
      if (!option) continue;

      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, optionText);
}

async function selectCustomOption(page, optionText) {
  const alreadySelected = await page.getByText(optionText, { exact: false }).first().isVisible().catch(() => false);
  if (alreadySelected) {
    const count = await page.getByText(optionText, { exact: false }).count().catch(() => 0);
    if (count === 1) return true;
  }

  const dropdownBox = await page.evaluate((targetText) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("button,[role='button'],div,a")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.text.includes(targetText)
        && candidate.width > 180
        && candidate.height >= 28
        && candidate.height <= 90
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    return candidates[0] || null;
  }, optionText);

  if (dropdownBox) {
    await humanDelay(page, `before selected option click ${optionText}`, 900, 2200);
    await humanClick(page, dropdownBox.x + dropdownBox.width - 28, dropdownBox.y + dropdownBox.height / 2, `product dropdown ${optionText}`);
    await humanDelay(page, "after product dropdown open", 1200, 2600);
  } else {
    const rightDropdown = await page.evaluate(() => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const candidates = [...document.querySelectorAll("button,[role='button'],div,a")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          };
        })
        .filter((candidate) =>
          candidate.y > 120
          && candidate.y < 330
          && candidate.x > window.innerWidth * 0.45
          && candidate.width > 180
          && candidate.height >= 35
          && candidate.height <= 90
        )
        .sort((a, b) => b.x - a.x);

      return candidates[0] || null;
    });

    if (!rightDropdown) return false;
    await humanDelay(page, "before SpaceCloud product dropdown click", 900, 2200);
    await humanClick(page, rightDropdown.x + rightDropdown.width - 28, rightDropdown.y + rightDropdown.height / 2, "SpaceCloud product dropdown");
    await humanDelay(page, "after SpaceCloud product dropdown click", 1200, 2600);
  }

  const option = page.getByText(optionText, { exact: false }).last();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await humanDelay(page, `before product option click ${optionText}`, 900, 2200);
  await humanClickElement(page, option, `product option ${optionText}`);
  await humanDelay(page, `after product option click ${optionText}`, 1500, 3400);
  return true;
}

async function selectProduct(page, room) {
  const productName = ROOM_PRODUCT_NAMES[room];

  if (await selectNativeSelectOption(page, productName)) {
    await humanDelay(page, "after native product select", 1300, 3000);
  } else if (!(await selectCustomOption(page, productName))) {
    throw new Error(`Could not select SpaceCloud product: ${productName}`);
  }

  const selected = await page.locator("body").innerText({ timeout: 10_000 });
  if (!selected.includes(productName)) {
    throw new Error(`SpaceCloud product selection was not verified: ${productName}`);
  }
}

async function clickMonthArrow(page, direction) {
  const box = await page.evaluate((targetDirection) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const className = targetDirection === "previous" ? "btn_prev" : "btn_next";
    const textName = targetDirection === "previous" ? "\uc774\uc804\ub2ec" : "\ub2e4\uc74c\ub2ec";
    const direct = [...document.querySelectorAll(`a.${className},button.${className},[role='button'].${className}`)]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .find((candidate) => candidate.width >= 8 && candidate.height >= 8);

    if (direct) return direct;

    const byText = [...document.querySelectorAll("button,a,[role='button'],div,span")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.text === textName
        && candidate.y > 250
        && candidate.y < 520
        && candidate.width >= 8
        && candidate.width <= 120
        && candidate.height >= 8
        && candidate.height <= 80
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];

    if (byText) return byText;

    const candidates = [...document.querySelectorAll("button,a,[role='button'],div")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.y > 300
        && candidate.y < 520
        && candidate.x > window.innerWidth * 0.25
        && candidate.x < window.innerWidth * 0.78
        && candidate.width >= 20
        && candidate.width <= 90
        && candidate.height >= 20
        && candidate.height <= 90
      )
      .sort((a, b) => a.x - b.x);

    if (candidates.length === 0) return null;
    return targetDirection === "previous" ? candidates[0] : candidates[candidates.length - 1];
  }, direction);

  if (!box) throw new Error(`Could not find SpaceCloud ${direction} month arrow.`);

  await humanDelay(page, `before ${direction} month click`, 900, 2200);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, `${direction} month`);
  await humanDelay(page, `after ${direction} month click`, 1600, 3600);
}

async function navigateToMonth(page, dateValue) {
  const target = parseDateValue(dateValue);
  const targetIndex = monthIndex(target.year, target.month);
  const targetKey = monthKey(dateValue);

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    const current = parseVisibleMonth(text);
    if (!current) {
      await humanDelay(page, "wait for SpaceCloud month title", 1000, 2400);
      continue;
    }

    if (current.key === targetKey) return;

    const currentIndex = monthIndex(current.year, current.month);
    await clickMonthArrow(page, targetIndex < currentIndex ? "previous" : "next");
  }

  throw new Error(`Could not navigate SpaceCloud calendar to ${targetKey}.`);
}

async function clickAddReservation(page) {
  await clickVisibleText(page, TEXT.addReservation, 20_000);
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return text.includes("\uc678\ubd80\uc608\uc57d") || text.includes("\ud734\ubb34\uc77c");
    },
    null,
    { timeout: 20_000 },
  );
  await humanDelay(page, "after SpaceCloud add modal open", 1200, 2800);
}

async function fillInputByIndex(page, index, value) {
  const handle = await page.evaluateHandle(({ index, value }) => {
    const inputs = [...document.querySelectorAll("input,textarea")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const type = (element.getAttribute("type") || "text").toLowerCase();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0
          && !element.disabled
          && !["checkbox", "radio", "button", "submit", "reset", "hidden"].includes(type);
      });
    const target = inputs[index];
    if (!target) return null;
    const prototype = target.tagName.toLowerCase() === "textarea"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(target, value);
    else target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return target;
  }, { index, value });

  const element = handle.asElement();
  if (!element) throw new Error(`Could not fill SpaceCloud modal input index ${index}.`);
  await humanDelay(page, `after input ${index} fill`, 500, 1200);
}

async function chooseTimeSelect(page, selectIndex, hour) {
  const label = hourLabel(hour);

  const nativeSelected = await page.evaluate(({ selectIndex, label, hour }) => {
    const selects = [...document.querySelectorAll("select")]
      .filter((element) => {
        if (element.disabled) return false;
        return [...element.options].some((item) => /\d+\s*\uc2dc/.test((item.textContent || "").replace(/\s+/g, " ")));
      });
    const target = selects[selectIndex];
    if (!target) return false;

    const option = [...target.options].find((item) => {
      const text = (item.textContent || "").replace(/\s+/g, "");
      return text.includes(label) || text === String(hour);
    });
    if (!option) return false;

    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(target, option.value);
    else target.value = option.value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selectIndex, label, hour });

  if (nativeSelected) {
    await humanDelay(page, `after native time select ${label}`, 700, 1700);
    return;
  }

  const box = await page.evaluate(({ selectIndex }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("button,[role='button'],div")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((candidate) =>
        candidate.y > 250
        && candidate.y < 470
        && candidate.width >= 80
        && candidate.width <= 220
        && candidate.height >= 35
        && candidate.height <= 90
        && /\d+\s*\uc2dc/.test(candidate.text)
      )
      .sort((a, b) => a.x - b.x);

    return candidates[selectIndex] || null;
  }, { selectIndex });

  if (!box) throw new Error(`Could not find SpaceCloud time dropdown index ${selectIndex}.`);

  await humanDelay(page, `before custom time dropdown ${selectIndex}`, 700, 1700);
  await humanClick(page, box.x + box.width - 28, box.y + box.height / 2, `time dropdown ${selectIndex}`);
  await humanDelay(page, `after custom time dropdown ${selectIndex}`, 700, 1700);

  const option = page.getByText(new RegExp(`${hour}\\s*\\uc2dc`)).last();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await humanDelay(page, `before custom time option ${label}`, 700, 1700);
  await humanClickElement(page, option, `time option ${label}`);
  await humanDelay(page, `after custom time option ${label}`, 800, 1900);
}

async function ensureNotFullDay(page) {
  await page.evaluate((fullDayText) => {
    const labels = [...document.querySelectorAll("label")];
    const label = labels.find((item) => (item.textContent || "").includes(fullDayText));
    const input = label?.querySelector("input[type='checkbox']");
    if (input && input.checked && !input.disabled) {
      input.click();
    }
  }, TEXT.fullDay);
  await humanDelay(page, "after full-day safety check", 400, 1000);
}

async function addExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone, apply }) {
  await clickAddReservation(page);
  await saveScreenshot(page, "spacecloud-external-add-modal");

  await fillInputByIndex(page, 0, formatModalDate(dateValue));
  await chooseTimeSelect(page, 0, startHour);
  await chooseTimeSelect(page, 1, endHour);
  await ensureNotFullDay(page);
  await fillInputByIndex(page, 1, customerName || marker);
  if (phone) await fillInputByIndex(page, 2, phone);
  await fillInputByIndex(page, 3, marker);
  await saveScreenshot(page, "spacecloud-external-add-filled");

  if (!apply) {
    console.log("Dry run complete. Add --apply to create SpaceCloud external reservation.");
    return { ok: true, dryRun: true };
  }

  await clickVisibleText(page, TEXT.confirm, 20_000);
  await page.waitForFunction(
    (directAddedText) => !(document.body?.innerText || "").includes(directAddedText),
    TEXT.directAdded,
    { timeout: 20_000 },
  ).catch(() => {});
  await humanDelay(page, "after SpaceCloud external save", 2200, 5200);
  await saveScreenshot(page, "spacecloud-external-after-add");

  return { ok: true, dryRun: false };
}

async function findAndOpenExternalReservation(page, { dateValue, startHour, endHour, marker }) {
  const { day } = parseDateValue(dateValue);
  const dayText = String(day).padStart(2, "0");
  const altDayText = String(day);
  const timeText = shortTimeLabel(startHour, endHour);

  const candidates = await page.evaluate(({ dayText, altDayText, timeText }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function cellFor(element) {
      let current = element;
      for (let i = 0; i < 8 && current; i += 1) {
        const rect = current.getBoundingClientRect();
        const text = (current.textContent || "").replace(/\s+/g, " ").trim();
        const hasDay = new RegExp(`(^|\\s)(${dayText}|${altDayText})(\\s|$)`).test(text);
        if (hasDay && rect.width > 120 && rect.height > 80 && rect.y > 420) return current;
        current = current.parentElement;
      }
      return null;
    }

    const entries = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const cell = cellFor(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          inTargetCell: Boolean(cell),
        };
      })
      .filter((entry) =>
        entry.text.includes(timeText)
        && entry.inTargetCell
        && entry.y > 420
        && entry.width < 220
        && entry.height < 80
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    return entries.slice(0, 8);
  }, { dayText, altDayText, timeText });

  for (const candidate of candidates) {
    await humanDelay(page, "before SpaceCloud external item click", 900, 2200);
    await humanClick(page, candidate.x + candidate.width / 2, candidate.y + candidate.height / 2, "SpaceCloud external item");
    await humanDelay(page, "after SpaceCloud external item click", 1400, 3200);

    const popupText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    const dateMatches = popupText.includes(formatDetailDate(dateValue)) || popupText.includes(formatLooseDetailDate(dateValue));
    const timeMatches = popupText.includes(`${startHour}:00~${endHour}:00`)
      || popupText.includes(`${String(startHour).padStart(2, "0")}:00~${String(endHour).padStart(2, "0")}:00`);
    if (
      popupText.includes(TEXT.directAdded)
      && popupText.includes(marker)
      && dateMatches
      && timeMatches
    ) {
      return true;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(page, "after unmatched popup escape", 700, 1600);
  }

  return false;
}

async function deleteExternalReservation(page, { dateValue, startHour, endHour, marker, apply }) {
  const opened = await findAndOpenExternalReservation(page, { dateValue, startHour, endHour, marker });

  if (!opened) {
    console.log("No matching SpaceCloud external reservation was found. Treat as already open.");
    return { ok: true, alreadyOpen: true, dryRun: !apply };
  }

  await saveScreenshot(page, "spacecloud-external-delete-modal");

  if (!apply) {
    console.log("Dry run complete. Add --apply to delete matching SpaceCloud external reservation.");
    return { ok: true, alreadyOpen: false, dryRun: true };
  }

  let dialogAccepted = false;
  page.once("dialog", async (dialog) => {
    dialogAccepted = true;
    await humanDelay(page, "before SpaceCloud delete dialog accept", 700, 1600);
    await dialog.accept();
  });

  await clickVisibleText(page, TEXT.deleteReservation, 20_000);
  await humanDelay(page, "after SpaceCloud delete click", 1600, 3600);

  if (!dialogAccepted) {
    const confirmVisible = await page.getByText(TEXT.confirm, { exact: false }).last().isVisible().catch(() => false);
    if (confirmVisible) {
      await clickVisibleText(page, TEXT.confirm, 10_000);
    }
  }

  await humanDelay(page, "after SpaceCloud external delete", 2200, 5200);
  await saveScreenshot(page, "spacecloud-external-after-delete");
  return { ok: true, alreadyOpen: false, dryRun: false };
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
  const bookingNumber = requiredArg(args, "booking-number");
  const customerName = args["customer-name"] || "";
  const phone = args.phone || "";
  const apply = args.apply === "true";

  if (mode !== "close" && mode !== "open") throw new Error("--mode must be close or open");
  if (endHour <= startHour) throw new Error("--end must be after --start");
  parseDateValue(dateValue);

  if (!existsSync(spaceCloudStorageStatePath)) {
    throw new Error("SpaceCloud login session is missing. Run `npm run rpa:spacecloud-login` first.");
  }

  const marker = markerForBooking(bookingNumber);
  const browser = await launchRpaBrowser({ headless: false });
  let page;

  try {
    const context = await newRpaContext(browser, {
      storageState: spaceCloudStorageStatePath,
      blockHeavyResources: true,
    });
    page = await context.newPage();

    await openReservationList(page);
    await saveScreenshot(page, "spacecloud-external-01-list");
    await openCalendarView(page);
    await selectProduct(page, room);
    if (mode === "open") {
      await navigateToMonth(page, dateValue);
    }
    await saveScreenshot(page, "spacecloud-external-02-calendar");

    const result = mode === "close"
      ? await addExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone, apply })
      : await deleteExternalReservation(page, { dateValue, startHour, endHour, marker, apply });

    console.log(JSON.stringify({
      ...result,
      mode,
      room,
      date: dateValue,
      start: `${String(startHour).padStart(2, "0")}:00`,
      end: `${String(endHour).padStart(2, "0")}:00`,
      marker,
    }, null, 2));
  } catch (error) {
    console.error("SpaceCloud external reservation RPA failed:", error instanceof Error ? error.message : error);
    await page?.screenshot?.({ path: `rpa/screenshots/spacecloud-external-error-${Date.now()}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("\n" + usage());
  process.exit(1);
});
