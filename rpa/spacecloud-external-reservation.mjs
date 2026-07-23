import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext, resolveRpaHeadless } from "./lib/browser.mjs";
import { parseArgs, parseHour, parseRoom, requiredArg } from "./lib/cli.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { humanClick, humanClickElement, humanDelay } from "./lib/human.mjs";
import { spaceCloudStorageStatePath } from "./lib/paths.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";
import {
  locateSelfHealingControl,
  markSelfHealingControlFailed,
  markSelfHealingControlVerified,
} from "./lib/self-healing-controls.mjs";
import { spaceCloudBrowserOptions } from "./lib/spacecloud-session.mjs";
import { createStepTimer } from "./lib/step-timer.mjs";

const TEXT = {
  hostLogout: "\ud638\uc2a4\ud2b8 \ub85c\uadf8\uc544\uc6c3",
  login: "\ub85c\uadf8\uc778",
  reservationCalendar: "\uc608\uc57d/\uce98\ub9b0\ub354",
  reservationList: "\uc608\uc57d \uad00\ub9ac \ub9ac\uc2a4\ud2b8",
  calendarView: "\uce98\ub9b0\ub354 \ubcf4\uae30",
  addReservation: "\uc608\uc57d\ucd94\uac00",
  directAdded: "\uc9c1\uc811 \ucd94\uac00\ud55c \uc608\uc57d \uac74\uc785\ub2c8\ub2e4.",
  deleteReservation: "\uc608\uc57d \uc0ad\uc81c",
  editReservation: "\uc608\uc57d \uc218\uc815",
  confirm: "\ud655\uc778",
  cancel: "\ucde8\uc18c",
  fullDay: "\uc885\uc77c",
  noRepeat: "\ubc18\ubcf5\uc548\ud568",
  room1: "\uba38\ubb34\ub8f8 \ud68c\uc758\uc2e4 \uc608\uc57d\ud558\uae30 1",
  room2: "\uba38\ubb34\ub8f8 \ud68c\uc758\uc2e4 \uc608\uc57d\ud558\uae30 2",
  room3: "\uba38\ubb34\ub8f8 \ud68c\uc758\uc2e4 \uc608\uc57d\ud558\uae30 3",
};

const SPACECLOUD_ADD_RESERVATION_CONTROL = {
  key: "spacecloud.calendar.add-reservation",
  primaryLabels: ["예약추가"],
  aliases: ["예약 추가", "외부예약 추가", "외부 예약 추가", "예약 등록", "일정 추가"],
  semanticTokens: ["예약", "추가"],
  excludeLabels: ["예약 삭제", "예약 수정", "취소"],
  minScore: 85,
  minMargin: 12,
};

const SPACECLOUD_MODAL_CONFIRM_CONTROL = {
  key: "spacecloud.external-modal.confirm",
  primaryLabels: ["확인"],
  aliases: ["저장", "등록", "적용", "완료"],
  excludeLabels: ["취소", "삭제"],
  region: { minYRatio: 0.5, maxYRatio: 1 },
  minScore: 85,
  minMargin: 12,
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
  "3": TEXT.room3,
};

function usage() {
  return [
    "Usage:",
    "  npm run rpa:spacecloud-external -- --room=1 --date=2026-07-03 --start=11:00 --end=15:00 --mode=close --booking-number=123 --apply",
    "",
    "Options:",
    "  --room=1|2|3",
    "  --date=YYYY-MM-DD",
    "  --start=HH:00",
    "  --end=HH:00",
    "  --mode=close|open|resize",
    "  --booking-number=NaverBookingNumber",
    "  --customer-name=Name  optional, used as SpaceCloud external reservation name",
    "  --phone=010-0000-0000 optional, used as SpaceCloud external reservation contact",
    "  --allow-still-blocked-after-delete optional, treat open as success when another reservation still blocks the slot",
    "  --claim-unlabelled-before-delete optional, link one exact unlabelled manual block before deleting it",
    "  --claim-only optional, only attach identity to one exact unlabelled manual block; never create a new block",
    "  --new-start=HH:00 --new-end=HH:00 required with --mode=resize",
    "  --inspect-calendar optional, print the exact selected product/date cell and exit without editing",
    "  --inspect-save-request optional, inspect and block the final save request before it reaches SpaceCloud",
    "  --health-check optional, read-only UI contract check; opens and closes the add modal without saving",
    "  --apply       actually add/delete the SpaceCloud external reservation.",
  ].join("\n");
}

function normalizeNaverBookingNumber(bookingNumber) {
  return String(bookingNumber || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:naver|네이버)\s*[:#-]?\s*/i, "")
    .trim();
}

function markerForBooking(bookingNumber) {
  return `네이버 예약번호: ${normalizeNaverBookingNumber(bookingNumber)}`;
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
  const { year, month, day } = parseDateValue(dateValue);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${year}. ${String(month).padStart(2, "0")}. ${String(day).padStart(2, "0")} (${WEEKDAYS[weekday]})`;
}

function hourLabel(hour) {
  return `${hour}\uc2dc`;
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

function resetSpaceCloudMutationError(page) {
  page.__spaceCloudLastApiError = null;
}

function throwIfSpaceCloudMutationFailed(page, actionLabel) {
  const apiError = page.__spaceCloudLastApiError;
  if (!apiError) return;

  if (
    actionLabel === "external reservation save"
    && apiError.body?.includes("\ud574\ub2f9 \uae30\uac04\uc5d0 \uc774\ubbf8 \uc608\uc57d\uc774 \uc788\uc2b5\ub2c8\ub2e4")
  ) {
    return;
  }

  if (apiError.status === 401 || apiError.status === 403) {
    throw new Error(
      `SpaceCloud login required. ${actionLabel} was rejected with ${apiError.status} ${apiError.url}.`,
    );
  }

  throw new Error(
    `SpaceCloud ${actionLabel} failed with ${apiError.status}: ${apiError.body || apiError.url}`,
  );
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
  for (let attempt = 0; attempt < 12; attempt += 1) {
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

    if (attempt === 3) {
      await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
      await humanDelay(page, "after SpaceCloud calendar recovery reload", 1600, 3400);
      await assertLoggedIn(page);
    } else {
      await humanDelay(page, "wait for SpaceCloud reservation list/calendar", 1200, 3000);
    }
  }

  throw new Error("Could not open SpaceCloud calendar view.");
}

async function isCalendarView(page) {
  return page.evaluate((addReservationText) => {
    const text = document.body?.innerText || "";
    const weekdayCount = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]
      .filter((weekday) => text.includes(weekday)).length;
    return text.includes(addReservationText)
      && /\b20\d{2}\.\d{1,2}\b/.test(text)
      && weekdayCount >= 2;
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

async function getSelectedProductState(page) {
  return page.evaluate(({ room1, room2, room3 }) => {
    const productNames = [room1, room2, room3];
    const select = [...document.querySelectorAll("select")].find((candidate) => {
      const optionTexts = [...candidate.options].map((option) => (option.textContent || "").trim());
      return productNames.every((productName) => optionTexts.includes(productName));
    });

    if (!select) return { nativeSelectFound: false, selectedText: "", selectedValue: "" };
    return {
      nativeSelectFound: true,
      selectedText: (select.selectedOptions[0]?.textContent || "").trim(),
      selectedValue: select.value,
    };
  }, { room1: TEXT.room1, room2: TEXT.room2, room3: TEXT.room3 });
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
  const currentState = await getSelectedProductState(page);

  if (currentState.nativeSelectFound && currentState.selectedText === productName) {
    console.log(`SpaceCloud product is already selected: ${productName}`);
    return;
  }

  if (await selectNativeSelectOption(page, productName)) {
    await humanDelay(page, "after native product select", 1300, 3000);
  } else if (!(await selectCustomOption(page, productName))) {
    throw new Error(`Could not select SpaceCloud product: ${productName}`);
  }

  const selectedState = await getSelectedProductState(page);
  if (selectedState.nativeSelectFound && selectedState.selectedText !== productName) {
    throw new Error(
      `SpaceCloud product selection mismatch: expected ${productName}, got ${selectedState.selectedText || "(empty)"}.`,
    );
  }

  if (!selectedState.nativeSelectFound) {
    const selected = await page.locator("body").innerText({ timeout: 10_000 });
    if (!selected.includes(productName)) {
      throw new Error(`SpaceCloud product selection was not verified: ${productName}`);
    }
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

function calendarDayCellIndex(dateValue) {
  const { year, month, day } = parseDateValue(dateValue);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return firstWeekday + day - 1;
}

async function getCalendarDayCellBox(page, dateValue, { scrollIntoView = false } = {}) {
  const { day } = parseDateValue(dateValue);
  const cellIndex = calendarDayCellIndex(dateValue);

  return page.evaluate(({ cellIndex, day, scrollIntoView }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const weekdayNames = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
    const table = [...document.querySelectorAll("table")]
      .filter(visible)
      .find((candidate) => {
        const headers = [...candidate.querySelectorAll("thead th")]
          .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim());
        return headers.length === 7 && headers.every((header, index) => header === weekdayNames[index]);
      });
    if (!table) return null;

    const cells = [...table.querySelectorAll("tbody td")];
    const cell = cells[cellIndex];
    if (!cell) return null;

    const dateLabel = cell.querySelector(".date")
      || [...cell.querySelectorAll("span,div")].find((element) => (element.textContent || "").trim() === String(day));
    if (!dateLabel || Number((dateLabel.textContent || "").trim()) !== day) return null;

    if (scrollIntoView) {
      const initialRect = cell.getBoundingClientRect();
      if (initialRect.top < 0 || initialRect.bottom > window.innerHeight) {
        cell.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }

    const rect = cell.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      cellIndex,
      dayText: (dateLabel.textContent || "").trim(),
      cellText: (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim(),
    };
  }, { cellIndex, day, scrollIntoView }).catch(() => null);
}

async function getCalendarDiagnostics(page, dateValue) {
  const selectedProduct = await getSelectedProductState(page);
  const targetCell = await getCalendarDayCellBox(page, dateValue, { scrollIntoView: false });
  return {
    selectedProduct,
    targetMonth: monthKey(dateValue),
    targetDate: dateValue,
    targetCell,
  };
}

async function isCalendarDayVisible(page, dateValue) {
  return Boolean(await getCalendarDayCellBox(page, dateValue));
}

async function waitForCalendarDay(page, dateValue, contextLabel) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isCalendarDayVisible(page, dateValue)) return;
    await humanDelay(page, `wait for SpaceCloud ${contextLabel} calendar data`, 650, 1100);
  }

  await saveScreenshot(page, `spacecloud-external-${contextLabel}-calendar-not-ready`);
  throw new Error(`SpaceCloud calendar data did not load for ${dateValue} before ${contextLabel}.`);
}

async function waitForAddReservationModal(page, timeout) {
  return page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
        && text.includes("\uc608\uc57d\ub0a0\uc9dc")
        && text.includes("\uc608\uc57d\uc2dc\uac04");
    },
    null,
    { timeout },
  ).then(() => true).catch(() => false);
}

async function getExternalReservationModalBounds(page) {
  return page.evaluate(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const candidates = [...document.querySelectorAll("div,section,article,form")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        return { rect, text, area: rect.width * rect.height };
      })
      .filter((item) =>
        item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
        && item.text.includes("\uc608\uc57d\ub0a0\uc9dc")
        && item.text.includes("\uc608\uc57d\uc2dc\uac04")
        && item.rect.width >= 360
        && item.rect.width <= 900
        && item.rect.height >= 360
        && item.rect.height <= window.innerHeight
      )
      .sort((left, right) => left.area - right.area);

    const rect = candidates[0]?.rect;
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });
}

async function clickAddReservation(page, { healthCheck = false } = {}) {
  let control = await locateSelfHealingControl(page, SPACECLOUD_ADD_RESERVATION_CONTROL, { healthCheck });
  await humanDelay(page, "before SpaceCloud add reservation click", 500, 1200);
  await humanClickElement(page, control.locator, "SpaceCloud add reservation");

  if (!(await waitForAddReservationModal(page, 5_000))) {
    console.log("SpaceCloud add modal did not open after the first verified click. Resolve and retry the same safe control once.");
    control = await locateSelfHealingControl(page, SPACECLOUD_ADD_RESERVATION_CONTROL, { healthCheck });
    await humanClickElement(page, control.locator, "SpaceCloud add reservation retry");
    if (!(await waitForAddReservationModal(page, 10_000))) {
      markSelfHealingControlFailed(control);
      throw new Error("[RPA_UI_CHANGE] SpaceCloud add reservation modal did not open after two verified click attempts.");
    }
  }

  if (!healthCheck) markSelfHealingControlVerified(control, { healthCheck: false });
  await humanDelay(page, "after SpaceCloud add modal open", 1200, 2800);
  return control;
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
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
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
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
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

  const control = await page.evaluate(({ direction }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const header = [...document.querySelectorAll(".calendar_ly_repeat .calendar_tit")]
      .find(visible);
    if (!header) return null;

    const rect = header.getBoundingClientRect();
    return {
      x: direction === "previous" ? rect.x + 16 : rect.x + rect.width - 16,
      y: rect.y + rect.height / 2,
      tag: header.tagName,
      className: typeof header.className === "string" ? header.className : "",
    };
  }, { direction });

  const x = control?.x ?? (direction === "previous" ? picker.x + 28 : picker.x + picker.width - 28);
  const y = control?.y ?? picker.y + 34;
  const startingIndex = monthIndex(picker.year, picker.month);
  const expectedIndex = monthIndex(picker.year, picker.month) + (direction === "previous" ? -1 : 1);
  console.log(`SpaceCloud modal date picker ${direction} control: ${JSON.stringify(control || { fallback: true })}`);

  for (let clickAttempt = 1; clickAttempt <= 2; clickAttempt += 1) {
    const beforeClick = await getModalDatePickerInfo(page);
    if (!beforeClick) {
      throw new Error("SpaceCloud modal date picker closed while changing month.");
    }
    const beforeClickIndex = monthIndex(beforeClick.year, beforeClick.month);
    if (beforeClickIndex === expectedIndex) {
      console.log(`SpaceCloud modal date picker moved to ${beforeClick.year}.${beforeClick.month}.`);
      return;
    }
    if (beforeClickIndex !== startingIndex) {
      throw new Error(`SpaceCloud modal date picker moved to an unexpected month: ${beforeClick.year}.${beforeClick.month}.`);
    }

    // The picker is visible slightly before its click handlers become ready.
    // A short readiness pause plus state polling is much faster than the old
    // multi-second fixed wait while still proving that each click took effect.
    await page.waitForTimeout(350);
    await humanClick(page, x, y, `modal date picker ${direction} month`);

    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      const updatedPicker = await getModalDatePickerInfo(page);
      if (updatedPicker && monthIndex(updatedPicker.year, updatedPicker.month) === expectedIndex) {
        console.log(`SpaceCloud modal date picker moved to ${updatedPicker.year}.${updatedPicker.month}.`);
        return;
      }
      await page.waitForTimeout(100);
    }

    console.log(`SpaceCloud modal date picker ${direction} click did not register; retrying once.`);
  }

  throw new Error(`SpaceCloud modal date picker did not move ${direction}.`);
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
  const { year, month, day } = parseDateValue(dateValue);
  const dayText = String(day).padStart(2, "0");

  const dayBox = await page.evaluate(({ year, month, day }) => {
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
        && Number(item.monthMatch[1]) === year
        && Number(item.monthMatch[2]) === month
        && item.text.includes("\uc624\ub298")
        && item.text.includes("\uc120\ud0dd")
        && item.rect.width >= 260
        && item.rect.width <= 640
        && item.rect.height >= 220
        && item.rect.height <= 560
      )
      .sort((a, b) => a.area - b.area);

    const picker = pickerCandidates[0];
    if (!picker) return null;

    const expectedIndex = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + day - 1;
    const tableCandidates = [...picker.element.querySelectorAll("table")]
      .filter(visible)
      .map((table) => {
        const cells = [...table.querySelectorAll("td")]
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = (element.textContent || "").replace(/\s+/g, " ").trim();
            return { element, rect, text };
          })
          .filter((cell) => /^\d{1,2}$/.test(cell.text) && cell.rect.width >= 18 && cell.rect.height >= 18)
          .sort((a, b) => Math.abs(a.rect.y - b.rect.y) > 3 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x);
        return { table, cells };
      })
      .filter((candidate) => candidate.cells.length >= 28 && candidate.cells.length <= 42)
      .sort((a, b) => b.cells.length - a.cells.length);

    for (const candidate of tableCandidates) {
      const cell = candidate.cells[expectedIndex];
      if (!cell || Number(cell.text) !== day) continue;
      const hit = document.elementFromPoint(
        cell.rect.x + cell.rect.width / 2,
        cell.rect.y + cell.rect.height / 2,
      );
      return {
        x: cell.rect.x,
        y: cell.rect.y,
        width: cell.rect.width,
        height: cell.rect.height,
        text: cell.text,
        gridIndex: expectedIndex,
        hitText: (hit?.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }

    return null;
  }, { year, month, day });

  if (!dayBox) throw new Error(`Could not find SpaceCloud modal date picker day: ${dayText}`);
  console.log("SpaceCloud date grid target:", JSON.stringify(dayBox));

  await humanDelay(page, `before modal date picker day ${dayText} click`, 450, 1000);
  await humanClick(page, dayBox.x + dayBox.width / 2, dayBox.y + dayBox.height / 2, `modal date picker day ${dayText}`);
  await humanDelay(page, "after modal date picker day click", 500, 1100);
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
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
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

  if (text === TEXT.confirm) {
    const bounds = await getExternalReservationModalBounds(page);
    if (!bounds) throw new Error("[RPA_UI_CHANGE] Could not verify the SpaceCloud external reservation modal bounds.");
    const control = await locateSelfHealingControl(page, {
      ...SPACECLOUD_MODAL_CONFIRM_CONTROL,
      bounds,
    });
    await humanDelay(page, `before modal ${text} click`, 350, 900);
    await humanClickElement(page, control.locator, `modal ${text}`);
    await humanDelay(page, `after modal ${text} click`, 500, 1200);
    return;
  }

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
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
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
          item.text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
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

async function reopenCalendarForVerification(page, { room, dateValue, contextLabel }) {
  await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
  await humanDelay(page, `after SpaceCloud reload for ${contextLabel}`, 1200, 2800);
  await assertLoggedIn(page);
  await openCalendarView(page);
  await assertCalendarView(page, contextLabel);
  await selectProduct(page, room);
  await assertCalendarView(page, `${contextLabel} month navigation`);
  await navigateToMonth(page, dateValue);
  await waitForCalendarDay(page, dateValue, contextLabel);
}

async function waitForCalendarTimeEntry(page, { dateValue, startHour, endHour }, contextLabel) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entry = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (entry?.fullyCovered) return entry;
    await humanDelay(page, `wait for SpaceCloud ${contextLabel} time entry`, 650, 1100);
  }

  return null;
}

async function waitForExternalReservation(page, options, contextLabel) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const opened = await findAndOpenExternalReservation(page, options);
    if (opened) return true;
    await humanDelay(page, `wait for SpaceCloud ${contextLabel} external reservation`, 650, 1100);
  }

  return false;
}

async function verifyExternalReservationAdded(page, {
  room,
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
}) {
  let lastVerificationError = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await reopenCalendarForVerification(page, {
        room,
        dateValue,
        contextLabel: `external reservation add verification ${attempt}`,
      });

      const opened = await waitForExternalReservation(page, {
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        strictIdentity: true,
      }, `add verification ${attempt}`);

      if (opened) {
        await saveScreenshot(page, "spacecloud-external-add-verified");
        await page.keyboard.press("Escape").catch(() => {});
        await humanDelay(page, "after verified SpaceCloud external popup escape", 500, 1200);
        console.log("SpaceCloud external reservation was verified from a freshly loaded calendar.");
        return;
      }
    } catch (error) {
      lastVerificationError = error instanceof Error ? error.message : String(error);
      console.log(
        `SpaceCloud add verification attempt ${attempt} could not complete: ${lastVerificationError}`,
      );
    }

    await saveScreenshot(page, `spacecloud-external-add-verification-retry-${attempt}`);
    if (attempt < 3) {
      await humanDelay(page, `wait before SpaceCloud add verification retry ${attempt}`, 900, 2000);
    }
  }

  await saveScreenshot(page, "spacecloud-external-add-verification-failed");
  throw new Error(
    `SpaceCloud external reservation save verification failed: matching reservation was not found after fresh reload ${dateValue} ${startHour}:00-${endHour}:00.${lastVerificationError ? ` Last error: ${lastVerificationError}` : ""}`,
  );
}

async function verifyTargetPeriodBlocked(page, {
  room,
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
}) {
  await reopenCalendarForVerification(page, {
    room,
    dateValue,
    contextLabel: "existing SpaceCloud block verification",
  });

  const matchingExternalReservation = await waitForExternalReservation(page, {
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
    strictIdentity: true,
  }, "existing block identity verification");
  if (matchingExternalReservation) {
    await saveScreenshot(page, "spacecloud-external-existing-block-verified");
    await page.keyboard.press("Escape").catch(() => {});
    console.log("SpaceCloud existing target block was verified from a freshly loaded calendar.");
    return;
  }

  const blocked = await waitForCalendarTimeEntry(page, { dateValue, startHour, endHour }, "existing block verification");
  if (!blocked) {
    await saveScreenshot(page, "spacecloud-external-existing-block-verification-failed");
    throw new Error(
      `SpaceCloud reported an existing reservation, but the target period was not blocked after fresh reload ${dateValue} ${startHour}:00-${endHour}:00.`,
    );
  }

  await saveScreenshot(page, "spacecloud-external-existing-block-verified");
  console.log("SpaceCloud existing target block was verified from a freshly loaded calendar.");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isClaimableManualExternalReservation(popupText, { customerName, phone }) {
  const normalizedText = popupText.normalize("NFKC").replace(/\s+/g, " ");
  const compactText = normalizedText.replace(/\s+/g, "");
  const hasBookingMarker = /\ub124\uc774\ubc84\uc608\uc57d\ubc88\ud638[:\uff1a]?\d+/.test(compactText);
  const hasPlaceholderName = /\uc608\uc57d\uc790\uba85\s*[:\uff1a]?\s*\uc774\ub984\s*\uc5c6\uc74c/.test(normalizedText);
  const hasPlaceholderPhone = /\uc804\ud654\ubc88\ud638\s*[:\uff1a]?\s*010\s*-\s*0000\s*-\s*0000/.test(normalizedText);
  const hasEmptyMemo = /\uba54\ubaa8\s*[:\uff1a]?\s*(?:-|\uc5c6\uc74c)(?:\s|$)/.test(normalizedText);
  const normalizedCustomerName = String(customerName || "").normalize("NFKC").trim();
  const hasMatchingName = Boolean(normalizedCustomerName) && new RegExp(
    `\\uc608\\uc57d\\uc790\\uba85\\s*[:\\uff1a]?\\s*${escapeRegExp(normalizedCustomerName)}(?:\\s|$)`,
  ).test(normalizedText);
  const displayedPhone = normalizedText
    .match(/\uc804\ud654\ubc88\ud638\s*[:\uff1a]?\s*([0-9][0-9\s-]{7,})/)?.[1]
    ?.replace(/\D/g, "") || "";
  const normalizedPhone = String(phone || "").replace(/\D/g, "");
  const hasMatchingPhone = Boolean(normalizedPhone) && displayedPhone === normalizedPhone;

  return !hasBookingMarker
    && (hasPlaceholderName || hasMatchingName)
    && (hasPlaceholderPhone || hasMatchingPhone)
    && hasEmptyMemo;
}

async function claimManualExternalReservation(page, {
  room,
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
  apply,
}) {
  const opened = await findAndOpenExternalReservation(page, {
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
    timeOnly: true,
  });
  if (!opened) return null;

  const popupText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (matchesExternalReservationPopup(popupText, {
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
    strictIdentity: true,
  })) {
    await saveScreenshot(page, "spacecloud-external-manual-block-already-linked");
    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(page, "after already-linked SpaceCloud popup escape", 500, 1200);
    console.log("Matching SpaceCloud external reservation already contains the Naver identity. Skip manual claim.");
    return { ok: true, alreadyClosed: true, alreadyLinked: true, dryRun: !apply };
  }

  if (!isClaimableManualExternalReservation(popupText, { customerName, phone })) {
    await saveScreenshot(page, "spacecloud-external-manual-block-ambiguous");
    throw new Error(
      `SpaceCloud exact-time external reservation already has identifying information. Not overwriting it automatically: ${dateValue} ${startHour}:00-${endHour}:00.`,
    );
  }

  await saveScreenshot(page, "spacecloud-external-manual-block-before-claim");
  if (!apply) {
    await page.keyboard.press("Escape").catch(() => {});
    console.log("Matching unlabelled manual SpaceCloud block was found. Add --apply to attach Naver identity.");
    return { ok: true, alreadyClosed: true, manualBlockNeedsIdentity: true, dryRun: true };
  }

  await clickVisibleText(page, TEXT.editReservation, 20_000);
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
        && text.includes("\uc608\uc57d\ub0a0\uc9dc")
        && text.includes("\uc608\uc57d\uc2dc\uac04");
    },
    null,
    { timeout: 20_000 },
  );
  await humanDelay(page, "after SpaceCloud manual block edit open", 500, 1200);

  await fillInputByIndex(page, 1, customerName || marker);
  if (phone) await fillInputByIndex(page, 2, phone);
  await fillInputByIndex(page, 3, marker);
  await saveScreenshot(page, "spacecloud-external-manual-block-claimed-filled");
  resetSpaceCloudMutationError(page);
  await clickModalTextButton(page, TEXT.confirm, 20_000);
  await humanDelay(page, "after SpaceCloud manual block identity save", 700, 1600);
  throwIfSpaceCloudMutationFailed(page, "manual block identity save");

  await verifyExternalReservationAdded(page, {
    room,
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
  });

  console.log("SpaceCloud manual block was linked to the Naver reservation and verified.");
  return { ok: true, alreadyClosed: true, manualBlockClaimed: true, dryRun: false };
}

async function resizeExternalReservation(page, {
  room,
  dateValue,
  startHour,
  endHour,
  newStartHour,
  newEndHour,
  marker,
  customerName,
  phone,
  apply,
}) {
  if (startHour === newStartHour && endHour === newEndHour) {
    return { ok: true, resized: false, alreadySized: true, dryRun: !apply };
  }

  const opened = await findAndOpenExternalReservation(page, {
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
    strictIdentity: true,
  });

  if (!opened) {
    const alreadyResized = await findAndOpenExternalReservation(page, {
      dateValue,
      startHour: newStartHour,
      endHour: newEndHour,
      marker,
      customerName,
      phone,
      strictIdentity: true,
    });
    if (alreadyResized) {
      await page.keyboard.press("Escape").catch(() => {});
      return { ok: true, resized: false, alreadySized: true, dryRun: !apply };
    }

    throw new Error(
      `SpaceCloud grouped external reservation was not found for resize: ${dateValue} ${startHour}:00-${endHour}:00.`,
    );
  }

  await saveScreenshot(page, "spacecloud-external-before-resize");
  if (!apply) {
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: true, resized: false, wouldResize: true, dryRun: true };
  }

  await clickVisibleText(page, TEXT.editReservation, 20_000);
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return text.includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c")
        && text.includes("\uc608\uc57d\ub0a0\uc9dc")
        && text.includes("\uc608\uc57d\uc2dc\uac04");
    },
    null,
    { timeout: 20_000 },
  );
  await humanDelay(page, "after SpaceCloud grouped reservation edit open", 500, 1200);

  await chooseTimeSelect(page, 0, newStartHour);
  await chooseTimeSelect(page, 1, newEndHour);
  await saveScreenshot(page, "spacecloud-external-resize-filled");
  resetSpaceCloudMutationError(page);
  await clickModalTextButton(page, TEXT.confirm, 20_000);
  await humanDelay(page, "after SpaceCloud grouped reservation resize", 700, 1600);
  throwIfSpaceCloudMutationFailed(page, "external reservation resize");

  await verifyExternalReservationAdded(page, {
    room,
    dateValue,
    startHour: newStartHour,
    endHour: newEndHour,
    marker,
    customerName,
    phone,
  });

  console.log("SpaceCloud grouped external reservation time was resized and verified.");
  return { ok: true, resized: true, dryRun: false };
}

async function addExternalReservation(page, {
  room,
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
  apply,
  claimOnly = false,
  skipCalendarPrecheck = false,
  timingStep = () => {},
}) {
  if (!skipCalendarPrecheck) {
    const alreadyAdded = await findAndOpenExternalReservation(page, {
      dateValue,
      startHour,
      endHour,
      marker,
      customerName,
      phone,
      strictIdentity: true,
    });
    if (alreadyAdded) {
      await saveScreenshot(page, "spacecloud-external-already-added");
      await page.keyboard.press("Escape").catch(() => {});
      await humanDelay(page, "after already-added popup escape", 700, 1600);
      console.log("Matching SpaceCloud external reservation already exists. Skip duplicate add.");
      return { ok: true, alreadyClosed: true, alreadyLinked: true, dryRun: !apply };
    }

    const claimedManualBlock = await claimManualExternalReservation(page, {
      room,
      dateValue,
      startHour,
      endHour,
      marker,
      customerName,
      phone,
      apply,
    });
    if (claimedManualBlock) return claimedManualBlock;

    if (claimOnly) {
      const blocked = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
      console.log(
        blocked?.fullyCovered
          ? "SpaceCloud target is blocked, but no exact unlabelled manual block can be claimed. No change made."
          : "No exact unlabelled manual SpaceCloud block was found. No change made.",
      );
      return {
        ok: true,
        claimOnly: true,
        noClaimableManualBlock: true,
        targetBlocked: Boolean(blocked?.fullyCovered),
        dryRun: !apply,
      };
    }

    const alreadyBlocked = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (alreadyBlocked?.fullyCovered) {
      await saveScreenshot(page, "spacecloud-external-already-blocked");
      console.log("SpaceCloud target period already appears blocked. Treat close as success.");
      return {
        ok: true,
        alreadyClosed: true,
        manualOrExistingBlock: true,
        coveredUnmatched: true,
        dryRun: !apply,
      };
    }
    if (alreadyBlocked?.hasOverlap) {
      await saveScreenshot(page, "spacecloud-external-partially-blocked");
      throw new Error(
        `SpaceCloud target period is only partially blocked: ${dateValue} ${startHour}:00-${endHour}:00. Not treating partial coverage as success.`,
      );
    }
  }

  await clickAddReservation(page);
  await saveScreenshot(page, "spacecloud-external-add-modal");
  timingStep("add-modal-ready");
  await typeModalDate(page, dateValue);
  await assertModalDate(page, dateValue);

  await chooseTimeSelect(page, 0, startHour);
  await chooseTimeSelect(page, 1, endHour);
  await ensureNotFullDay(page);
  await fillInputByIndex(page, 1, customerName || marker);
  if (phone) await fillInputByIndex(page, 2, phone);
  await fillInputByIndex(page, 3, marker);
  await saveScreenshot(page, "spacecloud-external-add-filled");
  timingStep("add-form-ready");

  if (!apply) {
    console.log("Dry run complete. Add --apply to create SpaceCloud external reservation.");
    return { ok: true, dryRun: true };
  }

  resetSpaceCloudMutationError(page);
  await clickModalTextButton(page, TEXT.confirm, 20_000);
  await humanDelay(page, "after SpaceCloud external save response", 500, 1000);
  throwIfSpaceCloudMutationFailed(page, "external reservation save");
  try {
    await page.waitForFunction(
      () => !(document.body?.innerText || "").includes("\uc678\ubd80\uc608\uc57d/\ud734\ubb34\uc77c \ucd94\uac00"),
      null,
      { timeout: 20_000 },
    );
  } catch (error) {
    const lastErrorBody = page.__spaceCloudLastErrorBody || "";
    if (lastErrorBody.includes("\ud574\ub2f9 \uae30\uac04\uc5d0 \uc774\ubbf8 \uc608\uc57d\uc774 \uc788\uc2b5\ub2c8\ub2e4")) {
      console.log("SpaceCloud says the target period is already reserved. Verify the calendar before treating close as success.");
      await saveScreenshot(page, "spacecloud-external-already-reserved");
      await page.keyboard.press("Escape").catch(() => {});

      // The calendar can be stale during the initial precheck. If a person
      // already added an unlabelled external block for this exact period,
      // attach the Naver identity now so a later cancellation can delete only
      // the block that belongs to this reservation.
      await reopenCalendarForVerification(page, {
        room,
        dateValue,
        contextLabel: "existing SpaceCloud block identity claim",
      });
      const claimedManualBlock = await claimManualExternalReservation(page, {
        room,
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        apply,
      });
      if (claimedManualBlock) return claimedManualBlock;

      await verifyTargetPeriodBlocked(page, {
        room,
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
      });
      return { ok: true, alreadyClosed: true, coveredUnmatched: true, dryRun: false };
    }
    throw error;
  }
  await humanDelay(page, "after SpaceCloud external save", 900, 2200);
  await saveScreenshot(page, "spacecloud-external-after-add");
  timingStep("external-reservation-saved");

  await verifyExternalReservationAdded(page, {
    room,
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
  });
  timingStep("external-reservation-verified");

  return { ok: true, created: true, dryRun: false };
}

async function findAndOpenExternalReservation(page, {
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
  strictIdentity = false,
  timeOnly = false,
}) {
  const targetCell = await getCalendarDayCellBox(page, dateValue, { scrollIntoView: true });
  if (!targetCell) return false;

  const candidates = await page.evaluate(({ targetCell, startHour, endHour }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function matchesTargetTime(text) {
      const compactText = text.replace(/\s+/g, "");
      const matches = [...compactText.matchAll(/(?:^|[^0-9])0?(\d{1,2})~0?(\d{1,2})(?:[^0-9]|$)/g)];
      return matches.some((match) => Number(match[1]) === startHour && Number(match[2]) === endHour);
    }

    function isInsideTargetCell(rect) {
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      return centerX >= targetCell.x
        && centerX <= targetCell.x + targetCell.width
        && centerY >= targetCell.y
        && centerY <= targetCell.y + targetCell.height;
    }

    const entries = [...document.querySelectorAll("body *")]
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
          inTargetCell: isInsideTargetCell(rect),
        };
      })
      .filter((entry) =>
        matchesTargetTime(entry.text)
        && entry.text.replace(/\s+/g, "").startsWith("\ucd94")
        && entry.inTargetCell
        && entry.y > 420
        && entry.width < 220
        && entry.height < 80
      )
      .sort((a, b) => {
        const compactTarget = `${startHour}~${endHour}`;
        const aExact = a.text.replace(/\s+/g, "").includes(compactTarget) ? 0 : 1;
        const bExact = b.text.replace(/\s+/g, "").includes(compactTarget) ? 0 : 1;
        return aExact - bExact || (a.width * a.height) - (b.width * b.height);
      });

    // A calendar item has several nested elements with the same text. Clicking
    // more than one candidate only reopens the same detail popup repeatedly.
    return entries.slice(0, 1);
  }, { targetCell, startHour, endHour });

  for (const candidate of candidates) {
    await humanDelay(page, "before SpaceCloud external item click", 900, 2200);
    const clickX = candidate.x + Math.min(Math.max(candidate.width * 0.45, 18), candidate.width - 4);
    await humanClick(page, clickX, candidate.y + candidate.height / 2, "SpaceCloud external item");
    await humanDelay(page, "after SpaceCloud external item click", 1400, 3200);

    const popupText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    if (matchesExternalReservationPopup(popupText, {
      dateValue,
      startHour,
      endHour,
      marker,
      customerName,
      phone,
      strictIdentity,
      timeOnly,
    })) {
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

function matchesExternalReservationPopup(popupText, {
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
  strictIdentity = false,
  timeOnly = false,
}) {
  const normalizedText = popupText.normalize("NFKC").replace(/\s+/g, " ");
  const compactText = normalizedText.replace(/\s+/g, "");
  const compactMarker = marker.replace(/\s+/g, "");
  const compactPhone = phone.replace(/\D/g, "");
  const compactDigits = compactText.replace(/\D/g, "");
  const { year, month, day } = parseDateValue(dateValue);
  const detailDate = `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
  const looseDetailDate = `${year}.${month}.${day}`;
  const directAdded = TEXT.directAdded.replace(/\s+/g, "");

  const escapedYear = String(year).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const datePattern = new RegExp(`${escapedYear}\\s*[.\\-/]\\s*0?${month}\\s*[.\\-/]\\s*0?${day}`);
  const timePattern = new RegExp(`${startHour}\\s*:\\s*00\\s*[~～-]\\s*${endHour}\\s*:\\s*00`);
  const dateMatches = compactText.includes(detailDate)
    || compactText.includes(looseDetailDate)
    || datePattern.test(normalizedText);
  const timeMatches = compactText.includes(`${startHour}:00~${endHour}:00`)
    || compactText.includes(`${String(startHour).padStart(2, "0")}:00~${String(endHour).padStart(2, "0")}:00`)
    || compactText.includes(`${startHour}~${endHour}`)
    || timePattern.test(normalizedText);
  const markerMatches = compactText.includes(compactMarker) || popupText.includes(marker);
  const customerMatches = !customerName || popupText.includes(customerName);
  const phoneMatches = !compactPhone || compactDigits.includes(compactPhone);
  const identityMatches = strictIdentity
    ? markerMatches && customerMatches && phoneMatches
    : markerMatches
      || (customerName ? customerMatches : false)
      || (compactPhone ? phoneMatches : false);

  const directAddedMatches = compactText.includes(directAdded)
    || /\uc9c1\uc811\s*\ucd94\uac00\ud55c\s*\uc608\uc57d\s*\uac74\uc785\ub2c8\ub2e4[.]?/.test(normalizedText);

  return directAddedMatches
    && (timeOnly || identityMatches)
    && dateMatches
    && timeMatches;
}

async function findCalendarTimeEntry(page, { dateValue, startHour, endHour }) {
  const targetCell = await getCalendarDayCellBox(page, dateValue, { scrollIntoView: true });
  if (!targetCell) return null;

  return page.evaluate(({ targetCell, startHour, endHour }) => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function timeRanges(compactText) {
      return [...compactText.matchAll(/(\d{1,2})\s*~\s*(\d{1,2})/g)]
        .map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
        .filter((range) =>
          Number.isFinite(range.start)
          && Number.isFinite(range.end)
          && range.start >= 0
          && range.end <= 24
          && range.start < range.end
        );
    }

    function isInsideTargetCell(rect) {
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      return centerX >= targetCell.x
        && centerX <= targetCell.x + targetCell.width
        && centerY >= targetCell.y
        && centerY <= targetCell.y + targetCell.height;
    }

    const entries = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const compactText = text.replace(/\s+/g, "");
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          compactText,
          ranges: timeRanges(compactText),
          inTargetCell: isInsideTargetCell(rect),
        };
      })
      .filter((entry) =>
        entry.inTargetCell
        && entry.ranges.some((range) => range.start < endHour && range.end > startHour)
        && entry.y > 420
        && entry.width < 260
        && entry.height < 90
      )
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    if (entries.length === 0) return null;

    const uniqueRanges = new Map();
    for (const entry of entries) {
      for (const range of entry.ranges) {
        if (range.start < endHour && range.end > startHour) {
          uniqueRanges.set(`${range.start}-${range.end}`, range);
        }
      }
    }

    const intervals = [...uniqueRanges.values()]
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let coveredUntil = startHour;
    for (const interval of intervals) {
      if (interval.end <= coveredUntil) continue;
      if (interval.start > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, interval.end);
      if (coveredUntil >= endHour) break;
    }

    return {
      ...entries[0],
      intervals,
      hasOverlap: intervals.length > 0,
      fullyCovered: coveredUntil >= endHour,
    };
  }, { targetCell, startHour, endHour });
}

async function deleteExternalReservation(page, {
  room,
  dateValue,
  startHour,
  endHour,
  marker,
  customerName,
  phone,
  apply,
  allowStillBlockedAfterDelete = false,
  claimUnlabelledBeforeDelete = false,
  timingStep = () => {},
}) {
  let opened = await findAndOpenExternalReservation(page, {
    dateValue,
    startHour,
    endHour,
    marker,
    customerName,
    phone,
    strictIdentity: true,
  });

  if (!opened && claimUnlabelledBeforeDelete) {
    const claimed = await claimManualExternalReservation(page, {
      room,
      dateValue,
      startHour,
      endHour,
      marker,
      customerName,
      phone,
      apply,
    });

    if (claimed?.manualBlockNeedsIdentity && claimed.dryRun) {
      return {
        ok: true,
        alreadyOpen: false,
        wouldClaimAndDeleteManualBlock: true,
        dryRun: true,
      };
    }

    if (claimed) {
      opened = await findAndOpenExternalReservation(page, {
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        strictIdentity: true,
      });
      if (!opened) {
        throw new Error(
          `SpaceCloud manual block was linked, but could not be reopened for safe deletion: ${dateValue} ${startHour}:00-${endHour}:00.`,
        );
      }
    }
  }

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
      opened = matchesExternalReservationPopup(popupText, {
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        strictIdentity: true,
      });
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
  timingStep("delete-modal-ready");

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

  resetSpaceCloudMutationError(page);
  await clickVisibleText(page, TEXT.deleteReservation, 20_000);
  await humanDelay(page, "after SpaceCloud delete click", 800, 1800);

  if (!dialogAccepted) {
    await clickDeleteConfirmButton(page);
  }

  await humanDelay(page, "after SpaceCloud external delete", 900, 2200);
  throwIfSpaceCloudMutationFailed(page, "external reservation delete");
  await saveScreenshot(page, "spacecloud-external-after-delete");
  timingStep("external-reservation-deleted");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await reopenCalendarForVerification(page, {
      room,
      dateValue,
      contextLabel: `external reservation delete verification ${attempt}`,
    });
    await humanDelay(page, `wait for SpaceCloud delete verification data ${attempt}`, 1200, 2200);

    const deletedReservationStillExists = await findAndOpenExternalReservation(page, {
      dateValue,
      startHour,
      endHour,
      marker,
      customerName,
      phone,
      strictIdentity: true,
    });

    if (deletedReservationStillExists) {
      await saveScreenshot(page, `spacecloud-external-delete-verification-retry-${attempt}`);
      await page.keyboard.press("Escape").catch(() => {});
      if (attempt < 3) {
        await humanDelay(page, `wait before SpaceCloud delete verification retry ${attempt}`, 900, 2000);
        continue;
      }
      throw new Error(
        `SpaceCloud external reservation delete verification failed: matching reservation still exists after fresh reload ${dateValue} ${startHour}:00-${endHour}:00.`,
      );
    }

    const stillBlockedAfterDelete = await findCalendarTimeEntry(page, { dateValue, startHour, endHour });
    if (stillBlockedAfterDelete) {
      await saveScreenshot(page, "spacecloud-external-delete-still-blocked");
      if (allowStillBlockedAfterDelete) {
        console.log("SpaceCloud target slot is still blocked after delete. Treat as success because another active reservation should keep it closed.");
        return { ok: true, alreadyOpen: false, stillBlockedAfterDelete: true, dryRun: false };
      }
      throw new Error(
        `SpaceCloud external reservation open failed: target slot is still blocked after delete ${dateValue} ${startHour}:00-${endHour}:00.`,
      );
    }

    await saveScreenshot(page, "spacecloud-external-delete-verified");
    timingStep("external-reservation-delete-verified");
    console.log("SpaceCloud external reservation deletion was verified from a freshly loaded calendar.");
    return { ok: true, alreadyOpen: false, dryRun: false };
  }

  throw new Error("SpaceCloud external reservation delete verification ended unexpectedly.");
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
  const endHour = parseHour(requiredArg(args, "end"), "--end", true);
  const mode = args.mode || "close";
  const bookingNumber = requiredArg(args, "booking-number");
  const customerName = args["customer-name"] || "";
  const phone = args.phone || "";
  const apply = args.apply === "true";
  const inspectCalendar = args["inspect-calendar"] === "true";
  const inspectSaveRequest = args["inspect-save-request"] === "true";
  const healthCheck = args["health-check"] === "true";
  const claimOnly = args["claim-only"] === "true";
  const allowStillBlockedAfterDelete = args["allow-still-blocked-after-delete"] === "true";
  const claimUnlabelledBeforeDelete = args["claim-unlabelled-before-delete"] === "true";
  const newStartHour = mode === "resize"
    ? parseHour(requiredArg(args, "new-start"), "--new-start")
    : null;
  const newEndHour = mode === "resize"
    ? parseHour(requiredArg(args, "new-end"), "--new-end", true)
    : null;
  const timer = createStepTimer("spacecloud-external", {
    room,
    date: dateValue,
    start: args.start,
    end: args.end,
    mode,
    apply,
  });

  if (!["close", "open", "resize"].includes(mode)) throw new Error("--mode must be close, open, or resize");
  if (claimOnly && mode !== "close") throw new Error("--claim-only can only be used with --mode=close");
  if (endHour <= startHour) throw new Error("--end must be after --start");
  if (mode === "resize" && newEndHour <= newStartHour) {
    throw new Error("--new-end must be after --new-start");
  }
  parseDateValue(dateValue);

  if (!existsSync(spaceCloudStorageStatePath)) {
    throw new Error("SpaceCloud login session is missing. Run `npm run rpa:spacecloud-login` first.");
  }

  const rawMarker = markerForBooking(bookingNumber);
  const marker = rawMarker.includes("?") ? `\ub124\uc774\ubc84 \uc608\uc57d\ubc88\ud638: ${bookingNumber}` : rawMarker;
  const releaseLock = await acquireProcessLock("rpa/.locks/spacecloud-external-reservation.lock", {
    label: "SpaceCloud external reservation RPA",
    timeoutMs: 12 * 60 * 1000,
    staleMs: 15 * 60 * 1000,
    failIfLocked: healthCheck,
  });
  timer.mark("lock-acquired");
  const headless = resolveRpaHeadless();
  const browserOptions = spaceCloudBrowserOptions(headless);
  console.log(`[SpaceCloud network] Use ${browserOptions.useProxy ? "proxy" : "direct"} session path.`);
  let browser;
  let page;

  try {
    browser = await launchRpaBrowser(browserOptions);
    const context = await newRpaContext(browser, {
      storageState: spaceCloudStorageStatePath,
      blockHeavyResources: true,
      rpaRole: "spacecloud",
    });
    page = await context.newPage();
    timer.mark("browser-ready", { headless, reuse: browserOptions.reuse });
    if (inspectSaveRequest) {
      await page.route(
        "https://api.spacecloud.kr/partner/products/*/external_schedules",
        async (route) => {
          const request = route.request();
          const headers = await request.allHeaders().catch(() => ({}));
          const authorization = headers.authorization || "";
          const authorizationToken = authorization.replace(/^Bearer\s+/i, "");
          const localStorageToken = await page.evaluate(() => {
            try {
              return JSON.parse(localStorage.getItem("spacecloud__userInfo") || "null")?.accessToken || "";
            } catch {
              return "";
            }
          }).catch(() => "");
          let bodyKeys = [];
          let schedule = {};
          try {
            const body = request.postDataJSON();
            bodyKeys = body && typeof body === "object" ? Object.keys(body).sort() : [];
            schedule = body && typeof body === "object"
              ? Object.fromEntries(
                ["SDATE", "EDATE", "SHOUR", "EHOUR"]
                  .filter((key) => key in body)
                  .map((key) => [key, String(body[key])]),
              )
              : {};
          } catch {
            // Keep malformed or non-JSON bodies redacted.
          }
          console.log(`[SpaceCloud save request inspection] ${JSON.stringify({
            method: request.method(),
            hasAuthorizationHeader: Boolean(authorization),
            authorizationScheme: /^Bearer\s+/i.test(authorization)
              ? "Bearer"
              : authorization
                ? "raw-token"
                : null,
            matchesLocalStorageToken: Boolean(authorizationToken)
              && authorizationToken === localStorageToken,
            headerNames: Object.keys(headers).sort(),
            bodyKeys,
            schedule,
          })}`);
          await route.fulfill({
            status: 418,
            contentType: "application/json",
            body: JSON.stringify({ error: "Memoroom save request inspection; request was not sent." }),
          });
        },
      );
    }
    page.__spaceCloudLastErrorBody = "";
    page.__spaceCloudLastApiError = null;
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
          if (/^https:\/\/api\.spacecloud\.kr\/partner\//i.test(response.url())) {
            page.__spaceCloudLastApiError = {
              status: response.status(),
              url: response.url(),
              body,
            };
          }
          if (body) console.log(`[SpaceCloud response body] ${body.slice(0, 1000)}`);
        }
      }
    });

    await openReservationList(page);
    await saveScreenshot(page, "spacecloud-external-01-list");
    timer.mark("reservation-list-ready");
    await openCalendarView(page);
    await assertCalendarView(page, "product selection");
    await selectProduct(page, room);
    timer.mark("calendar-ready");

    if (healthCheck) {
      await assertCalendarView(page, "health check");
      const addControl = await clickAddReservation(page, { healthCheck: true });
      const modalBounds = await getExternalReservationModalBounds(page);
      if (!modalBounds) {
        throw new Error("[RPA_UI_CHANGE] SpaceCloud health check could not verify the add modal bounds.");
      }
      const confirmControl = await locateSelfHealingControl(page, {
        ...SPACECLOUD_MODAL_CONFIRM_CONTROL,
        bounds: modalBounds,
      }, { healthCheck: true });
      const evidencePath = await saveScreenshot(page, "spacecloud-ui-health-check");
      await page.keyboard.press("Escape").catch(() => {});
      const modalClosed = await waitForAddReservationModal(page, 1_500).then((open) => !open);
      if (!modalClosed) {
        throw new Error("[RPA_UI_CHANGE] SpaceCloud health check could not close the add modal without saving.");
      }
      markSelfHealingControlVerified(addControl, { healthCheck: true });
      markSelfHealingControlVerified(confirmControl, { healthCheck: true });
      console.log(JSON.stringify({
        ok: true,
        healthCheck: true,
        platform: "spacecloud",
        contract: "reservation-calendar-and-add-modal",
        currentUrl: page.url(),
        evidencePath,
      }));
      return;
    }

    await assertCalendarView(page, "month navigation");
    await navigateToMonth(page, dateValue);
    await waitForCalendarDay(
      page,
      dateValue,
      mode === "open" ? "delete target" : mode === "resize" ? "resize target" : "existing block precheck",
    );
    await assertCalendarView(
      page,
      mode === "open" ? "date selection" : mode === "resize" ? "resize selection" : "add reservation precheck",
    );
    await saveScreenshot(page, "spacecloud-external-02-calendar");
    timer.mark("target-date-ready");

    if (inspectCalendar) {
      console.log(JSON.stringify({
        ok: true,
        inspectOnly: true,
        ...(await getCalendarDiagnostics(page, dateValue)),
      }, null, 2));
      return;
    }

    const result = mode === "close"
      ? await addExternalReservation(page, {
        room,
        dateValue,
        startHour,
        endHour,
        marker,
        customerName,
        phone,
        apply,
        claimOnly,
        skipCalendarPrecheck: false,
        timingStep: (step, fields) => timer.mark(step, fields),
      })
      : mode === "open"
        ? await deleteExternalReservation(page, {
          room,
          dateValue,
          startHour,
          endHour,
          marker,
          customerName,
          phone,
          apply,
          allowStillBlockedAfterDelete,
          claimUnlabelledBeforeDelete,
          timingStep: (step, fields) => timer.mark(step, fields),
        })
        : await resizeExternalReservation(page, {
          room,
          dateValue,
          startHour,
          endHour,
          newStartHour,
          newEndHour,
          marker,
          customerName,
          phone,
          apply,
        });
    timer.mark("action-completed", { status: result.ok ? "ok" : "failed" });

    console.log(JSON.stringify({
      ...result,
      mode,
      room,
      date: dateValue,
      start: `${String(startHour).padStart(2, "0")}:00`,
      end: `${String(endHour).padStart(2, "0")}:00`,
      ...(mode === "resize" ? {
        newStart: `${String(newStartHour).padStart(2, "0")}:00`,
        newEnd: `${String(newEndHour).padStart(2, "0")}:00`,
      } : {}),
      marker,
    }, null, 2));
  } catch (error) {
    timer.mark("failed", { status: "error" });
    console.error("SpaceCloud external reservation RPA failed:", error instanceof Error ? error.message : error);
    const evidencePath = page
      ? await saveScreenshot(page, "spacecloud-external-error").catch(() => null)
      : null;
    if (evidencePath) console.error(`RPA_EVIDENCE_PATH=${evidencePath}`);
    throw error;
  } finally {
    await browser?.close();
    await releaseLock();
  }
}

main().catch((error) => {
  console.error("SpaceCloud external reservation RPA terminated:", error instanceof Error ? error.message : error);
  console.error("\n" + usage());
  process.exit(1);
});
