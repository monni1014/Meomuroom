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

async function clickDeleteConfirmButton(page) {
  const messageText = "\uc608\uc57d\uc744 \uc0ad\uc81c\ud558\uc2dc\uaca0\uc2b5\ub2c8\uae4c?";
  await page.waitForFunction(
    ({ message, confirm }) => {
      const text = document.body?.innerText || "";
      return text.includes(message) && text.includes(confirm);
    },
    { message: messageText, confirm: TEXT.confirm },
    { timeout: 10_000 },
  );

  const box = await page.evaluate(({ message, confirm }) => {
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

    const modalCandidates = [...document.querySelectorAll("div,section,article")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        return { rect, text, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.text.includes(message)
        && item.text.includes(confirm)
        && item.rect.width >= 240
        && item.rect.width <= 620
        && item.rect.height >= 120
        && item.rect.height <= 360
      )
      .sort((a, b) => a.area - b.area);

    const modal = modalCandidates[0]?.rect;
    if (!modal) return null;

    const buttons = [...document.querySelectorAll("button,a,[role='button'],div,span")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          exact: text === confirm,
          buttonLike: rect.width >= 80 && rect.height >= 34,
          bottomRight: rect.x > modal.x + modal.width / 2 && rect.y > modal.y + modal.height / 2,
          area: rect.width * rect.height,
        };
      })
      .filter((item) =>
        item.text.includes(confirm)
        && item.x >= modal.x
        && item.y >= modal.y
        && item.x + item.width <= modal.x + modal.width
        && item.y + item.height <= modal.y + modal.height
      )
      .sort((a, b) =>
        Number(b.bottomRight) - Number(a.bottomRight)
        || Number(b.buttonLike) - Number(a.buttonLike)
        || Number(b.exact) - Number(a.exact)
        || b.area - a.area
      );

    return buttons[0] || null;
  }, { message: messageText, confirm: TEXT.confirm });

  if (!box) throw new Error("Could not find SpaceCloud delete confirmation button.");

  await humanDelay(page, "before SpaceCloud delete confirm click", 350, 900);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, "SpaceCloud delete confirm");
  await humanDelay(page, "after SpaceCloud delete confirm click", 900, 1800);

  await page.waitForFunction(
    (message) => !(document.body?.innerText || "").includes(message),
    messageText,
    { timeout: 15_000 },
  ).catch(() => {});
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isCalendarView(page)) {
      await humanDelay(page, "after SpaceCloud calendar view open", 1600, 3600);
      return;
    }

    const bodyText = await page.locator("body").innerText({ timeout: 15_000 }).catch(() => "");
    if (bodyText.includes(TEXT.calendarView)) {
      await clickCalendarViewButton(page);
      await page.waitForFunction(
        ({ addReservation }) => {
          const text = document.body?.innerText || "";
          return text.includes(addReservation) && /\b20\d{2}\.\d{1,2}\b/.test(text);
        },
        { addReservation: TEXT.addReservation },
        { timeout: 30_000 },
      ).catch(() => {});
      continue;
    }

    await humanDelay(page, "wait for SpaceCloud reservation list/calendar", 1200, 3000);
  }

  throw new Error("Could not open SpaceCloud calendar view.");
}

async function isCalendarView(page) {
  return page.evaluate((addReservationText) => {
    const text = document.body?.innerText || "";
    return text.includes(addReservationText)
      && /\b20\d{2}\.\d{1,2}\b/.test(text)
      && text.includes("\uc77c\uc694\uc77c")
      && text.includes("\uc6d4\uc694\uc77c")
      && text.includes("\ud654\uc694\uc77c");
  }, TEXT.addReservation).catch(() => false);
}

async function assertCalendarView(page, contextLabel) {
  if (await isCalendarView(page)) return;
  await saveScreenshot(page, "spacecloud-external-not-calendar");
  throw new Error(`SpaceCloud calendar view is not ready before ${contextLabel}.`);
}

async function clickCalendarViewButton(page) {
  const box = await page.evaluate((calendarViewText) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("button,a,[role='button'],div,span")]
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
        candidate.text === calendarViewText
        && candidate.x > window.innerWidth * 0.5
        && candidate.y > 250
        && candidate.y < 520
        && candidate.width >= 80
        && candidate.width <= 220
        && candidate.height >= 35
        && candidate.height <= 90
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    return candidates[0] || null;
  }, TEXT.calendarView);

  if (!box) throw new Error("Could not find SpaceCloud calendar view button.");

  await humanDelay(page, "before SpaceCloud calendar view button click", 900, 2200);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, "SpaceCloud calendar view");
  await humanDelay(page, "after SpaceCloud calendar view button click", 1600, 3600);
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

async function selectCalendarDay(page, dateValue) {
  const { day } = parseDateValue(dateValue);
  const dayText = String(day).padStart(2, "0");
  const altDayText = String(day);

  const box = await page.evaluate(({ dayText, altDayText }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const hasDay = new RegExp(`^\\s*(${dayText}|${altDayText})(?!\\d)`).test(text);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          hasDay,
          area: rect.width * rect.height,
        };
      })
      .filter((item) =>
        item.hasDay
        && item.width >= 120
        && item.height >= 80
        && item.y > 420
        && item.y < window.innerHeight - 40
      )
      .sort((a, b) => a.area - b.area);

    return candidates[0] || null;
  }, { dayText, altDayText });

  if (!box) throw new Error(`Could not find SpaceCloud calendar day: ${dateValue}`);

  await humanDelay(page, `before SpaceCloud calendar day ${dateValue} click`, 900, 2200);
  await humanClick(page, box.x + Math.min(34, box.width / 2), box.y + Math.min(32, box.height / 3), `SpaceCloud calendar day ${dateValue}`);
  await humanDelay(page, `after SpaceCloud calendar day ${dateValue} click`, 900, 2200);
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

async function getModalDateInputValue(page) {
  return page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function modalBounds() {
      const elements = [...document.querySelectorAll("div,section,article,form")].filter(visible);
      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return { element, rect, text, area: rect.width * rect.height };
        })
        .filter((item) =>
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
          && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
          && item.text.includes("\uc608\uc57d\uc2dc\uac04")
        )
        .sort((a, b) => a.area - b.area);
      return candidates[0]?.element || null;
    }

    const modal = modalBounds();
    if (!modal) return "";
    const inputs = [...modal.querySelectorAll("input,textarea")]
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
    return inputs[0]?.value || "";
  });
}

async function assertModalDate(page, dateValue) {
  const expected = formatModalDate(dateValue).replace(/\s+/g, "");
  const actual = (await getModalDateInputValue(page)).replace(/\s+/g, "");

  if (actual !== expected) {
    await saveScreenshot(page, "spacecloud-external-date-mismatch");
    throw new Error(`SpaceCloud modal date mismatch. expected=${formatModalDate(dateValue)} actual=${actual || "-"}`);
  }
}

async function findModalDateInputBox(page) {
  return page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function modalBounds() {
      const elements = [...document.querySelectorAll("div,section,article,form")].filter(visible);
      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return { element, rect, text, area: rect.width * rect.height };
        })
        .filter((item) =>
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
          && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
          && item.text.includes("\uc608\uc57d\uc2dc\uac04")
        )
        .sort((a, b) => a.area - b.area);
      return candidates[0]?.element || null;
    }

    const modal = modalBounds();
    if (!modal) return null;
    const inputs = [...modal.querySelectorAll("input")]
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
    const input = inputs[0];
    if (!input) return null;
    const rect = input.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function openModalDatePicker(page) {
  if (await getModalDatePickerInfo(page)) return;

  const box = await findModalDateInputBox(page);
  if (!box) throw new Error("Could not find SpaceCloud modal date input.");

  await humanDelay(page, "before modal date picker icon click", 700, 1700);
  await humanClick(page, box.x + box.width - 28, box.y + box.height / 2, "modal date picker icon");
  await humanDelay(page, "after modal date picker open", 900, 2000);
}

async function getModalDatePickerInfo(page) {
  return page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("div,section,article")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const monthMatch = text.match(/\b(20\d{2})\.(\d{1,2})\b/);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text, monthMatch, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.monthMatch
        && item.text.includes("\uc624\ub298")
        && item.text.includes("\uc120\ud0dd")
        && item.width >= 260
        && item.width <= 640
        && item.height >= 220
        && item.height <= 560
      )
      .sort((a, b) => a.area - b.area);

    const picker = candidates[0];
    if (!picker || !picker.monthMatch) return null;

    return {
      x: picker.x,
      y: picker.y,
      width: picker.width,
      height: picker.height,
      year: Number(picker.monthMatch[1]),
      month: Number(picker.monthMatch[2]),
    };
  });
}

async function clickModalDatePickerMonthArrow(page, direction) {
  const picker = await getModalDatePickerInfo(page);
  if (!picker) throw new Error("Could not find SpaceCloud modal date picker.");

  const x = direction === "previous" ? picker.x + 28 : picker.x + picker.width - 28;
  const y = picker.y + 34;
  await humanDelay(page, `before modal date picker ${direction} month click`, 700, 1700);
  await humanClick(page, x, y, `modal date picker ${direction} month`);
  await humanDelay(page, `after modal date picker ${direction} month click`, 900, 2000);
}

async function navigateModalDatePickerToMonth(page, dateValue) {
  const target = parseDateValue(dateValue);
  const targetIndex = monthIndex(target.year, target.month);
  const targetKey = monthKey(dateValue);

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const picker = await getModalDatePickerInfo(page);
    if (!picker) {
      await humanDelay(page, "wait for modal date picker", 800, 1800);
      continue;
    }

    const currentKey = `${picker.year}.${picker.month}`;
    if (currentKey === targetKey) return;

    const currentIndex = monthIndex(picker.year, picker.month);
    await clickModalDatePickerMonthArrow(page, targetIndex < currentIndex ? "previous" : "next");
  }

  throw new Error(`Could not navigate SpaceCloud modal date picker to ${targetKey}.`);
}

async function clickModalDatePickerDay(page, dateValue) {
  const { day } = parseDateValue(dateValue);
  const dayText = String(day).padStart(2, "0");
  const altDayText = String(day);

  const dayBox = await page.evaluate(({ dayText, altDayText }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const pickerCandidates = [...document.querySelectorAll("div,section,article")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const monthMatch = text.match(/\b(20\d{2})\.(\d{1,2})\b/);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text, monthMatch, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.monthMatch
        && item.text.includes("\uc624\ub298")
        && item.text.includes("\uc120\ud0dd")
        && item.width >= 260
        && item.width <= 640
        && item.height >= 220
        && item.height <= 560
      )
      .sort((a, b) => a.area - b.area);

    const picker = pickerCandidates[0];
    if (!picker) return null;

    function clickableBoxFor(element, picker) {
      let current = element;
      let best = null;

      for (let i = 0; i < 5 && current; i += 1) {
        const rect = current.getBoundingClientRect();
        const text = (current.textContent || "").replace(/\s+/g, " ").trim();
        const style = window.getComputedStyle(current);
        const role = current.getAttribute("role") || "";
        const tagName = current.tagName.toLowerCase();
        const isClickish = tagName === "button"
          || tagName === "a"
          || role === "button"
          || style.cursor === "pointer"
          || typeof current.onclick === "function";

        if (
          (text === dayText || text === altDayText)
          && rect.x >= picker.x
          && rect.y >= picker.y
          && rect.x + rect.width <= picker.x + picker.width
          && rect.y + rect.height <= picker.y + picker.height
          && rect.width >= 14
          && rect.width <= 90
          && rect.height >= 14
          && rect.height <= 90
        ) {
          best = {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            text,
            isClickish,
            area: rect.width * rect.height,
          };
        }

        if (current.parentElement && current.parentElement.contains(picker.element)) break;
        current = current.parentElement;
      }

      return best;
    }

    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const style = window.getComputedStyle(element);
        const color = style.color.match(/\d+/g)?.map(Number) || [];
        const isDimmed = color.length >= 3 && color[0] > 150 && color[1] > 150 && color[2] > 150;
        const clickBox = clickableBoxFor(element, picker);
        return {
          tagName: element.tagName,
          role: element.getAttribute("role") || "",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          isDimmed,
          clickBox,
          area: rect.width * rect.height,
        };
      })
      .filter((item) =>
        (item.text === dayText || item.text === altDayText)
        && !item.isDimmed
        && item.x >= picker.x
        && item.y >= picker.y
        && item.x + item.width <= picker.x + picker.width
        && item.y + item.height <= picker.y + picker.height
        && item.width >= 12
        && item.width <= 70
        && item.height >= 12
        && item.height <= 70
      )
      .map((item) => item.clickBox || item)
      .sort((a, b) =>
        Number(b.isClickish) - Number(a.isClickish)
        || b.area - a.area
      );

    return candidates[0] || null;
  }, { dayText, altDayText });

  if (!dayBox) throw new Error(`Could not find SpaceCloud modal date picker day: ${dayText}`);

  await humanDelay(page, `before modal date picker day ${dayText} click`, 700, 1700);
  await humanClick(page, dayBox.x + dayBox.width / 2, dayBox.y + dayBox.height / 2, `modal date picker day ${dayText}`);
  await humanDelay(page, "after modal date picker day click", 900, 2000);

  const expected = formatModalDate(dateValue).replace(/\s+/g, "");
  for (const [offsetX, offsetY] of [[0, 0], [-5, 0], [5, 0], [0, -5], [0, 5]]) {
    const selected = (await getModalDateInputValue(page)).replace(/\s+/g, "") === expected;
    if (selected) return;

    await page.mouse.click(
      dayBox.x + dayBox.width / 2 + offsetX,
      dayBox.y + dayBox.height / 2 + offsetY,
      { delay: 90 },
    );
    await humanDelay(page, `after precise modal day ${dayText} click`, 220, 520);
  }

  const clickedByDom = await page.evaluate(({ dayText, altDayText }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const pickerCandidates = [...document.querySelectorAll("div,section,article")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const monthMatch = text.match(/\b(20\d{2})\.(\d{1,2})\b/);
        return { element, rect, text, monthMatch, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.monthMatch
        && item.text.includes("\uc624\ub298")
        && item.text.includes("\uc120\ud0dd")
        && item.rect.width >= 260
        && item.rect.width <= 640
        && item.rect.height >= 220
        && item.rect.height <= 560
      )
      .sort((a, b) => a.area - b.area);

    const picker = pickerCandidates[0];
    if (!picker) return false;

    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const style = window.getComputedStyle(element);
        const color = style.color.match(/\d+/g)?.map(Number) || [];
        const isDimmed = color.length >= 3 && color[0] > 150 && color[1] > 150 && color[2] > 150;
        return { element, rect, text, isDimmed, area: rect.width * rect.height };
      })
      .filter((item) =>
        (item.text === dayText || item.text === altDayText)
        && !item.isDimmed
        && item.rect.x >= picker.rect.x
        && item.rect.y >= picker.rect.y
        && item.rect.x + item.rect.width <= picker.rect.x + picker.rect.width
        && item.rect.y + item.rect.height <= picker.rect.y + picker.rect.height
        && item.rect.width >= 8
        && item.rect.width <= 80
        && item.rect.height >= 8
        && item.rect.height <= 80
      )
      .sort((a, b) => b.area - a.area);

    const target = candidates[0]?.element;
    if (!target) return false;

    let clickable = target;
    for (let i = 0; i < 4 && clickable.parentElement; i += 1) {
      const parent = clickable.parentElement;
      const parentRect = parent.getBoundingClientRect();
      const parentText = (parent.textContent || "").replace(/\s+/g, " ").trim();
      if (
        (parentText === dayText || parentText === altDayText)
        && parentRect.x >= picker.rect.x
        && parentRect.y >= picker.rect.y
        && parentRect.x + parentRect.width <= picker.rect.x + picker.rect.width
        && parentRect.y + parentRect.height <= picker.rect.y + picker.rect.height
        && parentRect.width <= 90
        && parentRect.height <= 90
      ) {
        clickable = parent;
      }
    }

    clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, { dayText, altDayText });

  if (!clickedByDom) throw new Error(`Could not DOM-click SpaceCloud modal date picker day: ${dayText}`);
  await humanDelay(page, "after modal date picker DOM day click", 500, 1200);
}

async function setModalDateDirectly(page, dateValue) {
  const formatted = formatModalDate(dateValue);
  const ok = await page.evaluate((value) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function modalBounds() {
      const elements = [...document.querySelectorAll("div,section,article,form")].filter(visible);
      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return { element, rect, text, area: rect.width * rect.height };
        })
        .filter((item) =>
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
          && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
          && item.text.includes("\uc608\uc57d\uc2dc\uac04")
        )
        .sort((a, b) => a.area - b.area);
      return candidates[0]?.element || null;
    }

    const modal = modalBounds();
    if (!modal) return false;
    const inputs = [...modal.querySelectorAll("input")]
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

    const input = inputs[0];
    if (!input) return false;
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, formatted);

  if (!ok) throw new Error("Could not set SpaceCloud modal date input directly.");
  await humanDelay(page, "after direct modal date set", 350, 900);
}

async function typeModalDate(page, dateValue) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await openModalDatePicker(page);
    await navigateModalDatePickerToMonth(page, dateValue);
    await clickModalDatePickerDay(page, dateValue);

    const current = (await getModalDateInputValue(page)).replace(/\s+/g, "");
    const expected = formatModalDate(dateValue).replace(/\s+/g, "");
    if (current === expected) return;

    await saveScreenshot(page, `spacecloud-external-date-retry-${attempt}`);
    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(page, `retry modal date select ${attempt}`, 500, 1200);
  }

  await setModalDateDirectly(page, dateValue);
}

async function clickModalTextButton(page, text, timeout = 20_000) {
  await page.waitForFunction(
    (targetText) => (document.body?.innerText || "").includes(targetText),
    text,
    { timeout },
  );

  const box = await page.evaluate((targetText) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function modalBounds() {
      const elements = [...document.querySelectorAll("div,section,article,form")].filter(visible);
      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return { element, rect, text, area: rect.width * rect.height };
        })
        .filter((item) =>
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
          && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
          && item.text.includes("\uc608\uc57d\uc2dc\uac04")
          && item.rect.width >= 360
          && item.rect.width <= 900
          && item.rect.height >= 360
          && item.rect.height <= window.innerHeight
        )
        .sort((a, b) => a.area - b.area);

      const modal = candidates[0]?.rect;
      if (!modal) return null;
      return { x: modal.x, y: modal.y, width: modal.width, height: modal.height };
    }

    const modal = modalBounds();
    if (!modal) return null;

    const candidates = [...document.querySelectorAll("button,a,[role='button'],div")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const candidateText = (element.textContent || "").replace(/\s+/g, " ").trim();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text: candidateText,
          exact: candidateText === targetText,
          buttonLike: candidateText === targetText && rect.width >= 90 && rect.height >= 35,
          bottomRightButton: candidateText.includes(targetText)
            && rect.x > modal.x + modal.width / 2
            && rect.y > modal.y + modal.height - 110
            && rect.width >= 120
            && rect.height >= 40,
          area: rect.width * rect.height,
        };
      })
      .filter((candidate) =>
        candidate.text.includes(targetText)
        && candidate.x >= modal.x
        && candidate.y >= modal.y
        && candidate.x + candidate.width <= modal.x + modal.width
        && candidate.y + candidate.height <= modal.y + modal.height
        && candidate.width >= 60
        && candidate.height >= 30
      )
      .sort((a, b) =>
        Number(b.bottomRightButton) - Number(a.bottomRightButton)
        || Number(b.buttonLike) - Number(a.buttonLike)
        || Number(b.exact) - Number(a.exact)
        || b.area - a.area
        || b.y - a.y
      );

    return candidates[0] || null;
  }, text);

  if (!box) throw new Error(`Could not find SpaceCloud modal button: ${text}`);

  await humanDelay(page, `before modal ${text} click`, 350, 900);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, `modal ${text}`);
  await humanDelay(page, `after modal ${text} click`, 500, 1200);
}

async function fillInputByIndex(page, index, value) {
  const handle = await page.evaluateHandle(({ index }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function modalBounds() {
      const elements = [...document.querySelectorAll("div,section,article,form")].filter(visible);
      const candidates = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          return { element, rect, text, area: rect.width * rect.height };
        })
        .filter((item) =>
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
          && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
          && item.text.includes("\uc608\uc57d\uc2dc\uac04")
          && item.rect.width >= 360
          && item.rect.width <= 900
          && item.rect.height >= 360
          && item.rect.height <= window.innerHeight
        )
        .sort((a, b) => a.area - b.area);

      const modal = candidates[0]?.rect;
      if (!modal) return null;
      return { x: modal.x, y: modal.y, width: modal.width, height: modal.height };
    }

    const modal = modalBounds();
    if (!modal) return null;

    const inputs = [...document.querySelectorAll("input,textarea")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const type = (element.getAttribute("type") || "text").toLowerCase();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0
          && rect.x >= modal.x
          && rect.y >= modal.y
          && rect.x + rect.width <= modal.x + modal.width
          && rect.y + rect.height <= modal.y + modal.height
          && !element.disabled
          && !["checkbox", "radio", "button", "submit", "reset", "hidden"].includes(type);
      });
    const target = inputs[index];
    if (!target) return null;
    return target;
  }, { index });

  const element = handle.asElement();
  if (!element) throw new Error(`Could not fill SpaceCloud modal input index ${index}.`);
  const box = await element.boundingBox();
  if (!box) throw new Error(`Could not locate SpaceCloud modal input index ${index}.`);
  await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, `modal input ${index}`);
  await humanDelay(page, `after input ${index} click`, 180, 420);
  await element.fill(value, { timeout: 10_000 });
  await humanDelay(page, `after input ${index} fill`, 240, 620);
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
    await humanDelay(page, `after native time select ${label}`, 320, 800);
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

  await humanDelay(page, `before custom time dropdown ${selectIndex}`, 320, 800);
  await humanClick(page, box.x + box.width - 28, box.y + box.height / 2, `time dropdown ${selectIndex}`);
  await humanDelay(page, `after custom time dropdown ${selectIndex}`, 320, 800);

  const option = page.getByText(new RegExp(`${hour}\\s*\\uc2dc`)).last();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await humanDelay(page, `before custom time option ${label}`, 320, 800);
  await humanClickElement(page, option, `time option ${label}`);
  await humanDelay(page, `after custom time option ${label}`, 420, 1000);
}

async function ensureNotFullDay(page) {
  await page.evaluate((fullDayText) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const modal = [...document.querySelectorAll("div,section,article,form")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        return { element, rect, text, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00")
        && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
        && item.text.includes("\uc608\uc57d\uc2dc\uac04")
      )
      .sort((a, b) => a.area - b.area)[0]?.element || document.body;

    const labels = [...modal.querySelectorAll("label")];
    const label = labels.find((item) => (item.textContent || "").includes(fullDayText));
    const input = label?.querySelector("input[type='checkbox']");
    if (input && input.checked && !input.disabled) {
      input.click();
    }
  }, TEXT.fullDay);
  await humanDelay(page, "after full-day safety check", 220, 520);
}

async function addExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone, apply, skipCalendarPrecheck = false }) {
  if (!skipCalendarPrecheck) {
    const alreadyAdded = await findAndOpenExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone });
    if (alreadyAdded) {
      await saveScreenshot(page, "spacecloud-external-already-added");
      await page.keyboard.press("Escape").catch(() => {});
      await humanDelay(page, "after already-added popup escape", 700, 1600);
      console.log("Matching SpaceCloud external reservation already exists. Skip duplicate add.");
      return { ok: true, alreadyClosed: true, dryRun: !apply };
    }

    const alreadyBlocked = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (alreadyBlocked) {
      await saveScreenshot(page, "spacecloud-external-already-blocked");
      console.log("SpaceCloud target period already appears blocked. Treat close as success.");
      return { ok: true, alreadyClosed: true, manualOrExistingBlock: true, dryRun: !apply };
    }
  }

  await clickAddReservation(page);
  await saveScreenshot(page, "spacecloud-external-add-modal");
  await typeModalDate(page, dateValue);
  await assertModalDate(page, dateValue);

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

  await clickModalTextButton(page, TEXT.confirm, 20_000);
  try {
    await page.waitForFunction(
      () => !(document.body?.innerText || "").includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00"),
      null,
      { timeout: 20_000 },
    );
  } catch (error) {
    const lastErrorBody = page.__spaceCloudLastErrorBody || "";
    if (lastErrorBody.includes("\ud574\ub2f9 \uae30\uac04\uc5d0 \uc774\ubbf8 \uc608\uc57d\uc774 \uc788\uc2b5\ub2c8\ub2e4")) {
      console.log("SpaceCloud says the target period is already reserved. Treat close as success.");
      await saveScreenshot(page, "spacecloud-external-already-reserved");
      return { ok: true, alreadyClosed: true, dryRun: false };
    }
    throw error;
  }
  await humanDelay(page, "after SpaceCloud external save", 900, 2200);
  await saveScreenshot(page, "spacecloud-external-after-add");

  return { ok: true, dryRun: false };
}

async function findAndOpenExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone }) {
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
        const hasDay = new RegExp(`^\\s*(${dayText}|${altDayText})(?!\\d)`).test(text);
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
      .sort((a, b) => {
        const aExact = a.text.startsWith(timeText) ? 0 : 1;
        const bExact = b.text.startsWith(timeText) ? 0 : 1;
        return aExact - bExact || (a.width * a.height) - (b.width * b.height);
      });

    return entries.slice(0, 8);
  }, { dayText, altDayText, timeText });

  for (const candidate of candidates) {
    await humanDelay(page, "before SpaceCloud external item click", 900, 2200);
    const clickX = candidate.x + Math.min(Math.max(candidate.width * 0.45, 18), candidate.width - 4);
    await humanClick(page, clickX, candidate.y + candidate.height / 2, "SpaceCloud external item");
    await humanDelay(page, "after SpaceCloud external item click", 1400, 3200);

    const popupText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    if (matchesExternalReservationPopup(popupText, { dateValue, startHour, endHour, marker, customerName, phone })) {
      return true;
    }

    if (popupText.includes(TEXT.directAdded) || popupText.includes(TEXT.deleteReservation)) {
      await saveScreenshot(page, "spacecloud-external-unmatched-detail-popup");
      console.log("SpaceCloud external popup did not match target:");
      console.log(popupText.replace(/\s+/g, " ").slice(0, 1200));
    }

    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(page, "after unmatched popup escape", 700, 1600);
  }

  return false;
}

function matchesExternalReservationPopup(popupText, { dateValue, startHour, endHour, marker, customerName, phone }) {
  const compactText = popupText.replace(/\s+/g, "");
  const compactMarker = marker.replace(/\s+/g, "");
  const compactPhone = phone.replace(/\D/g, "");
  const compactDigits = compactText.replace(/\D/g, "");
  const detailDate = formatDetailDate(dateValue).replace(/\s+/g, "");
  const looseDetailDate = formatLooseDetailDate(dateValue).replace(/\s+/g, "");
  const directAdded = TEXT.directAdded.replace(/\s+/g, "");

  const dateMatches = compactText.includes(detailDate) || compactText.includes(looseDetailDate);
  const timeMatches = compactText.includes(`${startHour}:00~${endHour}:00`)
    || compactText.includes(`${String(startHour).padStart(2, "0")}:00~${String(endHour).padStart(2, "0")}:00`)
    || compactText.includes(`${startHour}~${endHour}`);
  const identityMatches = compactText.includes(compactMarker)
    || popupText.includes(marker)
    || (customerName ? popupText.includes(customerName) : false)
    || (compactPhone ? compactDigits.includes(compactPhone) : false);

  return compactText.includes(directAdded)
    && identityMatches
    && dateMatches
    && timeMatches;
}

async function findCalendarTimeEntry(page, { dateValue, startHour, endHour }) {
  const { day } = parseDateValue(dateValue);
  const dayText = String(day).padStart(2, "0");
  const altDayText = String(day);

  return page.evaluate(({ dayText, altDayText, startHour, endHour }) => {
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
        const hasDay = new RegExp(`^\\s*(${dayText}|${altDayText})(?!\\d)`).test(text);
        if (hasDay && rect.width > 120 && rect.height > 80 && rect.y > 420) return current;
        current = current.parentElement;
      }
      return null;
    }

    const startPattern = String(startHour).padStart(1, "0");
    const endPattern = String(endHour).padStart(1, "0");
    const timePattern = new RegExp(`(^|[^0-9])0?${startPattern}\\s*~\\s*0?${endPattern}([^0-9]|$)`);

    const entries = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const compactText = text.replace(/\s+/g, "");
        const cell = cellFor(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          compactText,
          inTargetCell: Boolean(cell),
        };
      })
      .filter((entry) =>
        entry.inTargetCell
        && timePattern.test(entry.compactText)
        && entry.y > 420
        && entry.width < 260
        && entry.height < 90
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    return entries[0] || null;
  }, { dayText, altDayText, startHour, endHour });
}

async function deleteExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone, apply }) {
  let opened = await findAndOpenExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone });

  if (!opened) {
    const stillBlocked = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (stillBlocked) {
      await humanDelay(page, "before SpaceCloud fallback block click", 700, 1400);
      await humanClick(
        page,
        stillBlocked.x + stillBlocked.width / 2,
        stillBlocked.y + stillBlocked.height / 2,
        "SpaceCloud fallback block",
      );
      await humanDelay(page, "after SpaceCloud fallback block click", 1200, 2600);

      const popupText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
      opened = matchesExternalReservationPopup(popupText, { dateValue, startHour, endHour, marker, customerName, phone });
    }
  }

  if (!opened) {
    const stillBlocked = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (stillBlocked) {
      await saveScreenshot(page, "spacecloud-external-unknown-block-still-exists");
      throw new Error(
        `SpaceCloud target period is blocked by an unknown/manual reservation: ${dateValue} ${startHour}:00-${endHour}:00. Not deleting without marker.`,
      );
    }

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
    await humanDelay(page, "before SpaceCloud delete dialog accept", 350, 900);
    await dialog.accept();
  });

  await clickVisibleText(page, TEXT.deleteReservation, 20_000);
  await humanDelay(page, "after SpaceCloud delete click", 800, 1800);

  if (!dialogAccepted) {
    await clickDeleteConfirmButton(page);
  }

  await humanDelay(page, "after SpaceCloud external delete", 900, 2200);
  await saveScreenshot(page, "spacecloud-external-after-delete");

  const stillBlockedAfterDelete = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
  if (stillBlockedAfterDelete) {
    await saveScreenshot(page, "spacecloud-external-delete-still-blocked");
    throw new Error(
      `SpaceCloud external reservation open failed: target slot is still blocked after delete ${dateValue} ${startHour}:00-${endHour}:00.`,
    );
  }

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

  const rawMarker = markerForBooking(bookingNumber);
  const marker = rawMarker.includes("?") ? `\ub124\uc774\ubc84 \uc608\uc57d\ubc88\ud638: ${bookingNumber}` : rawMarker;
  const browser = await launchRpaBrowser({ headless: false });
  let page;

  try {
    const context = await newRpaContext(browser, {
      storageState: spaceCloudStorageStatePath,
      blockHeavyResources: true,
    });
    page = await context.newPage();
    page.__spaceCloudLastErrorBody = "";
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        console.log(`[SpaceCloud browser ${message.type()}] ${message.text().slice(0, 500)}`);
      }
    });
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        console.log(`[SpaceCloud request] ${request.method()} ${request.url().slice(0, 300)}`);
      }
    });
    page.on("response", async (response) => {
      const request = response.request();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        console.log(`[SpaceCloud response] ${response.status()} ${response.url().slice(0, 300)}`);
        if (response.status() >= 400) {
          const body = await response.text().catch(() => "");
          page.__spaceCloudLastErrorBody = body;
          if (body) console.log(`[SpaceCloud response body] ${body.slice(0, 1000)}`);
        }
      }
    });

    await openReservationList(page);
    await saveScreenshot(page, "spacecloud-external-01-list");
    await openCalendarView(page);
    await assertCalendarView(page, "product selection");
    await selectProduct(page, room);

    if (mode === "open") {
      await assertCalendarView(page, "month navigation");
      await navigateToMonth(page, dateValue);
      await assertCalendarView(page, "date selection");
    } else {
      await assertCalendarView(page, "add reservation");
    }
    await saveScreenshot(page, "spacecloud-external-02-calendar");

    const result = mode === "close"
      ? await addExternalReservation(page, {
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        apply,
        skipCalendarPrecheck: true,
      })
      : await deleteExternalReservation(page, { dateValue, startHour, endHour, marker, customerName, phone, apply });

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
