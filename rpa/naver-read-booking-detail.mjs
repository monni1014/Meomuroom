import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext, resolveRpaHeadless } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { humanClickElement, humanDelay } from "./lib/human.mjs";
import {
  extractNaverBookingListRow,
  isValidNaverBookingNumber,
  isValidNaverCustomerName,
  isValidNaverDateTimeParts,
  isValidNaverPaymentStatus,
  isValidNaverPhone,
  isValidNaverPrice,
  isValidNaverProductName,
  isValidNaverQuantity,
} from "./lib/naver-booking-row.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";
import { createStepTimer } from "./lib/step-timer.mjs";

const BOOKING_LIST_URL = "https://partner.booking.naver.com/bizes/1473933/booking-list-view";
const DETAIL_READY_TIMEOUT_MS = Number(optionalEnv("NAVER_DETAIL_READY_TIMEOUT_MS", "28000"));
const BOOKING_LINK_TIMEOUT_MS = Number(optionalEnv("NAVER_BOOKING_LINK_TIMEOUT_MS", "12000"));

function parseArgs(argv) {
  const args = { _: [] };
  for (const item of argv.slice(2)) {
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const [key, ...valueParts] = item.slice(2).split("=");
    args[key] = valueParts.length > 0 ? valueParts.join("=") : "true";
  }
  return args;
}

function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function buildBookingListUrl(dateValue) {
  if (!dateValue) return BOOKING_LIST_URL;
  const params = new URLSearchParams({
    dateDropdownType: "MONTH",
    startDateTime: dateValue,
    endDateTime: addDays(dateValue, 30),
    dateFilter: "USEDATE",
    searchValueCode: "USER_NAME",
  });
  return `${BOOKING_LIST_URL}?${params.toString()}`;
}

function normalizeText(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function extractPhone(text) {
  const match = text.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractValueAfterLabels(text, labels) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (line === label && lines[i + 1]) return lines[i + 1].trim();
      const inlineMatch = line.match(new RegExp(`^${escapeRegExp(label)}(?:[:：\\s]+)(.+)$`));
      if (inlineMatch?.[1]) return inlineMatch[1].trim();
    }
  }

  return null;
}

function extractBookingNumber(text) {
  const match = text.match(/\b\d{9,12}\b/);
  return match ? match[0] : null;
}

function extractListRowByBookingId(text, bookingId) {
  if (!bookingId) return { customerName: null, phone: null };

  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let idIndex = 0; idIndex < lines.length; idIndex += 1) {
    if (!lines[idIndex].includes(bookingId)) continue;

    const lowerBound = Math.max(0, idIndex - 8);
    let phone = null;
    let phoneIndex = -1;

    for (let i = idIndex - 1; i >= lowerBound; i -= 1) {
      phone = extractPhone(lines[i]);
      if (phone) {
        phoneIndex = i;
        break;
      }
    }

    if (!phone || phoneIndex <= lowerBound) continue;

    const customerName = lines[phoneIndex - 1];
    if (customerName && !extractPhone(customerName) && !/\d{4,}/.test(customerName)) {
      return { customerName, phone };
    }
  }

  return { customerName: null, phone: null };
}

function extractCompactBookingInfo(text, bookingId) {
  if (!bookingId) return { customerName: null, phone: null };

  const compact = normalizeText(text).replace(/\s+/g, "");
  const id = escapeRegExp(bookingId);
  const phonePattern = "(01[016789]-?\\d{3,4}-?\\d{4})";

  const detailMatch = compact.match(new RegExp(`예약자([가-힣]{2,10})전화번호${phonePattern}예약번호${id}`));
  if (detailMatch) {
    return { customerName: detailMatch[1], phone: extractPhone(detailMatch[2]) };
  }

  const rowMatch = compact.match(new RegExp(`(?:확정|취소|노쇼|이용완료|확정대기)([가-힣]{2,10})${phonePattern}${id}`));
  if (rowMatch) {
    const statusNameMatches = [...rowMatch[1].matchAll(/(?:확정|취소|노쇼|이용완료|확정대기)?([가-힣]{2,5})/g)];
    const customerName = statusNameMatches.at(-1)?.[1] || rowMatch[1];
    return { customerName, phone: extractPhone(rowMatch[2]) };
  }

  return { customerName: null, phone: null };
}

function extractBookingStatus(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const closeIndex = lines.indexOf("닫기");
  const candidates = closeIndex >= 0 ? lines.slice(closeIndex + 1, closeIndex + 5) : lines.slice(0, 8);
  return candidates.find((line) => /^(확정|취소|노쇼|이용완료|확정대기)/.test(line)) || null;
}

function extractUseDateTime(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("이용일시")) {
      const dateText = line.replace(/^이용일시\s*/, "").trim() || lines[i + 1] || null;
      const timeText = line.includes("~") ? null : lines[i + 1] || null;
      return {
        dateText,
        timeText: timeText && timeText !== dateText ? timeText : null,
        combined: [dateText, timeText && timeText !== dateText ? timeText : null].filter(Boolean).join(" "),
      };
    }
  }

  return { dateText: null, timeText: null, combined: null };
}

async function waitForVisiblePhone(page, bookingId, timeout = DETAIL_READY_TIMEOUT_MS) {
  await page.waitForFunction(
    (id) => {
      const text = document.body?.innerText || document.body?.textContent || "";
      const compact = text.replace(/\s+/g, "");
      const hasTarget = !id || compact.includes(id);
      const hasPhone = /01[016789]-?\d{3,4}-?\d{4}/.test(compact);
      const hasDetailHint = /(?:\uC608\uC57D|\uC804\uD654\uBC88\uD638|\uACB0\uC81C|\uC774\uC6A9\uC77C\uC2DC|\uC0C1\uC138)/.test(text);

      return hasTarget && hasPhone && hasDetailHint;
    },
    bookingId,
    { timeout },
  );
}

async function retryNaverDetailReadiness(page, bookingId, timer) {
  try {
    await waitForVisiblePhone(page, bookingId);
    return;
  } catch {
    timer.mark("detail-ready-timeout", { status: "retry" });
    console.log("Naver detail phone was not visible yet. Reload once before final parse.");
    await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
    timer.mark("detail-reload-dom-ready");
    await waitForVisiblePhone(page, bookingId);
    timer.mark("detail-retry-ready");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const target = args._[0] || optionalEnv("NAVER_BOOKING_DETAIL_URL", "");
  if (!target) {
    throw new Error("Pass a Naver booking id/detail URL or set NAVER_BOOKING_DETAIL_URL in .env");
  }
  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }

  const bookingId = target.match(/\d{9,12}/)?.[0] || null;
  const timer = createStepTimer("naver-detail", {
    bookingId: bookingId || "direct-url",
  });
  const headless = resolveRpaHeadless();
  let browser;
  let page;

  try {
    browser = await launchRpaBrowser({ headless, reuse: headless });
    const context = await newRpaContext(browser, {
      storageState: naverStorageStatePath,
      rpaRole: "naver",
    });
    page = await context.newPage();
    timer.mark("browser-ready", { headless, reuse: headless });

    if (bookingId) {
      await page.goto(buildBookingListUrl(args.date), { timeout: 60_000, waitUntil: "domcontentloaded" });
      timer.mark("booking-list-dom-ready");

      const bookingLink = page.getByText(bookingId, { exact: true }).first();
      await bookingLink.waitFor({ state: "visible", timeout: BOOKING_LINK_TIMEOUT_MS });
      timer.mark("booking-link-visible");
      await humanDelay(page, "before booking detail click", 1800, 3600);
      await humanClickElement(page, bookingLink, "booking detail link");
      timer.mark("booking-detail-clicked");
      await page.waitForFunction((id) => {
        return [...document.querySelectorAll(
          '[class*="SideLayer__visible"], [class*="SideFrame__"], [class*="Detail__"], [role="dialog"]',
        )].some((element) => {
          const text = element.innerText || "";
          const compact = text.replace(/\s+/g, "");
          return text.includes("예약 상세정보")
            && compact.includes(id)
            && /01[016789]-?\d{3,4}-?\d{4}/.test(compact);
        });
      }, bookingId, { timeout: DETAIL_READY_TIMEOUT_MS }).catch(async () => {
        await retryNaverDetailReadiness(page, bookingId, timer);
      });
      timer.mark("booking-detail-ready");
    } else {
      await page.goto(target, { timeout: 60_000, waitUntil: "domcontentloaded" });
      timer.mark("booking-detail-url-dom-ready");
      await page.waitForFunction(() => {
        return [...document.querySelectorAll(
          '[class*="SideLayer__visible"], [class*="SideFrame__"], [class*="Detail__"], [role="dialog"]',
        )].some((element) => {
          const text = element.innerText || "";
          const compact = text.replace(/\s+/g, "");
          return text.includes("예약 상세정보")
            && compact.includes("예약자")
            && /01[016789]-?\d{3,4}-?\d{4}/.test(compact);
        });
      }, null, { timeout: DETAIL_READY_TIMEOUT_MS }).catch(async () => {
        await retryNaverDetailReadiness(page, null, timer);
      });
      timer.mark("booking-detail-ready");
    }

    const bodyText = await page.locator("body").innerText({ timeout: 20_000 });
    const visibleDetailPanelText = await page.evaluate((id) => {
      const selectors = [
        '[class*="SideLayer__visible"]',
        '[class*="SideFrame__"]',
        '[class*="Detail__"]',
        '[role="dialog"]',
      ];
      const candidates = selectors
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .map((element) => ({
          text: element.innerText || "",
          compact: (element.innerText || element.textContent || "").replace(/\s+/g, ""),
        }))
        .filter((item) => item.text.includes("예약 상세정보") && (!id || item.compact.includes(id)))
        .sort((left, right) => left.text.length - right.text.length);
      return candidates[0]?.text || "";
    }, bookingId);
    const text = normalizeText(bodyText);
    const detailStart = text.lastIndexOf("예약 상세정보");
    const detailText = normalizeText(visibleDetailPanelText)
      || (detailStart >= 0 ? text.slice(detailStart) : text);
    const detailUseDateTime = extractUseDateTime(detailText);
    const listDetail = extractNaverBookingListRow(bodyText, bookingId);
    const listRow = extractListRowByBookingId(text, bookingId);
    const compactInfo = extractCompactBookingInfo(text, bookingId);

    const extractedBookingNumber = extractValueAfterLabels(detailText, ["예약번호", "예약 번호"]);
    const bookingNumber = listDetail?.bookingNumber
      || (isValidNaverBookingNumber(extractedBookingNumber, bookingId) ? extractedBookingNumber : null)
      || bookingId
      || extractBookingNumber(detailText);
    const extractedProductName = extractValueAfterLabels(detailText, ["상품", "예약상품", "상품명"]);
    const productName = listDetail?.productName
      || (isValidNaverProductName(extractedProductName) ? extractedProductName : null);
    const useDateTime = isValidNaverDateTimeParts(listDetail?.useDateText, listDetail?.useTimeText)
      ? {
          combined: listDetail?.useDateTime || null,
          dateText: listDetail?.useDateText || null,
          timeText: listDetail?.useTimeText || null,
        }
      : detailUseDateTime;
    const extractedCustomerName = extractValueAfterLabels(detailText, ["예약자", "예약자명", "이름"]);
    // The booking list can show both the customer's original name and a
    // separate Korean display/transliteration on adjacent lines. Prefer the
    // explicitly labelled name in the opened detail panel so the reservation
    // keeps the exact name the customer submitted.
    const customerName = (isValidNaverCustomerName(extractedCustomerName) ? extractedCustomerName : null)
      || listDetail?.customerName
      || listRow.customerName
      || compactInfo.customerName
      || null;
    const extractedPhoneValue = extractValueAfterLabels(detailText, ["전화번호", "휴대폰 번호", "연락처"]);
    const extractedPhone = extractPhone(extractedPhoneValue || "") || extractPhone(detailText);
    const phone = listDetail?.phone
      || (isValidNaverPhone(extractedPhone) ? extractedPhone : null)
      || listRow.phone
      || compactInfo.phone
      || null;
    const extractedQuantity = extractValueAfterLabels(detailText, ["수량", "인원", "예약인원"]);
    const quantity = listDetail?.quantity
      || (isValidNaverQuantity(extractedQuantity) ? extractedQuantity : null);
    const extractedPaymentStatus = extractValueAfterLabels(detailText, ["결제상태", "결제 상태"]);
    const paymentStatus = listDetail?.paymentStatus
      || (isValidNaverPaymentStatus(extractedPaymentStatus) ? extractedPaymentStatus : null);
    const extractedPriceText = extractValueAfterLabels(detailText, ["결제금액", "결제 금액", "결제금액 합계"]);
    const priceText = listDetail?.priceText
      || (isValidNaverPrice(extractedPriceText) ? extractedPriceText : null);

    const result = {
      currentUrl: page.url(),
      screenshot: null,
      bookingStatus: listDetail?.bookingStatus || extractBookingStatus(detailText) || null,
      bookingNumber,
      customerName,
      phone,
      productName,
      useDateTime: useDateTime.combined || extractValueAfterLabels(detailText, ["이용일시", "예약일시", "방문일시"]),
      useDateText: useDateTime.dateText,
      useTimeText: useDateTime.timeText,
      quantity,
      paymentStatus,
      priceText,
      visibleTextSample: detailText.slice(0, 1200),
    };
    timer.mark("detail-parsed");

    if (!isValidNaverCustomerName(result.customerName) || result.customerName.includes("*")) {
      throw new Error("Naver detail customer name was not fully visible after retry.");
    }
    if (!isValidNaverPhone(result.phone)) {
      throw new Error("Naver detail phone number was not visible after retry.");
    }
    if (!isValidNaverBookingNumber(result.bookingNumber, bookingId)) {
      throw new Error(`Naver detail booking number was invalid: ${result.bookingNumber || "(empty)"}`);
    }
    if (!isValidNaverProductName(result.productName)) {
      throw new Error(`Naver detail product was invalid: ${result.productName || "(empty)"}`);
    }
    if (!isValidNaverDateTimeParts(result.useDateText, result.useTimeText)) {
      throw new Error(`Naver detail date/time was invalid: ${result.useDateText || ""} ${result.useTimeText || ""}`.trim());
    }

    const outputResult = args["redact-pii"] === "true"
      ? {
          ...result,
          customerName: result.customerName ? "[redacted]" : null,
          phone: result.phone ? "[redacted]" : null,
          visibleTextSample: "[redacted]",
        }
      : result;
    timer.mark("completed", { status: "ok" });
    console.log(JSON.stringify(outputResult, null, 2));
  } catch (error) {
    timer.mark("failed", {
      status: "error",
      error: error instanceof Error ? error.name : "unknown",
    });
    const evidencePath = page
      ? await saveScreenshot(page, "naver-booking-detail-error").catch(() => null)
      : null;
    if (page) {
      const title = await page.title().catch(() => "");
      console.error(`RPA_DIAGNOSTIC_URL=${page.url()}`);
      console.error(`RPA_DIAGNOSTIC_TITLE=${title}`);
    }
    if (evidencePath) console.error(`RPA_EVIDENCE_PATH=${evidencePath}`);
    throw error;
  } finally {
    await browser?.close();
  }
}

main().catch((error) => {
  console.error("Naver booking detail RPA read failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
