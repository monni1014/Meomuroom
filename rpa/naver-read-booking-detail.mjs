import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { optionalEnv } from "./lib/env.mjs";
import { naverStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";

const BOOKING_LIST_URL = "https://partner.booking.naver.com/bizes/1473933/booking-list-view";

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

function extractValueAfterLabels(text, labels) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (line === label && lines[i + 1]) return lines[i + 1].trim();
      if (line.startsWith(label)) {
        const value = line.slice(label.length).replace(/^[:：\s]+/, "").trim();
        if (value) return value;
      }
    }
  }

  return null;
}

function extractBookingNumber(text) {
  const match = text.match(/\b\d{9,12}\b/);
  return match ? match[0] : null;
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

async function main() {
  const args = parseArgs(process.argv);
  const target = args._[0] || optionalEnv("NAVER_BOOKING_DETAIL_URL", "");
  if (!target) {
    throw new Error("Pass a Naver booking id/detail URL or set NAVER_BOOKING_DETAIL_URL in .env");
  }
  if (!existsSync(naverStorageStatePath)) {
    throw new Error("Naver login session is missing. Run `npm run rpa:naver-login` first.");
  }

  const browser = await launchRpaBrowser({ headless: false });

  try {
    const context = await newRpaContext(browser, { storageState: naverStorageStatePath });
    const page = await context.newPage();
    const bookingId = target.match(/\d{9,12}/)?.[0] || null;

    if (bookingId) {
      await page.goto(buildBookingListUrl(args.date), { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);

      const bookingLink = page.getByText(bookingId, { exact: true }).first();
      await bookingLink.waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForTimeout(700);
      await bookingLink.click();
      await page.waitForTimeout(3500);
    } else {
      await page.goto(target, { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
    }

    const screenshot = await saveScreenshot(page, "naver-booking-detail-read");
    const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
    const text = normalizeText(bodyText);
    const detailStart = text.lastIndexOf("예약 상세정보");
    const detailText = detailStart >= 0 ? text.slice(detailStart) : text;
    const useDateTime = extractUseDateTime(detailText);

    const result = {
      currentUrl: page.url(),
      screenshot,
      bookingStatus: extractBookingStatus(detailText),
      bookingNumber: extractValueAfterLabels(detailText, ["예약번호", "예약 번호"]) || extractBookingNumber(detailText),
      customerName: extractValueAfterLabels(detailText, ["예약자", "예약자명", "이름"]),
      phone: extractValueAfterLabels(detailText, ["전화번호", "휴대폰 번호", "연락처"]) || extractPhone(detailText),
      productName: extractValueAfterLabels(detailText, ["상품", "예약상품", "상품명"]),
      useDateTime: useDateTime.combined || extractValueAfterLabels(detailText, ["이용일시", "예약일시", "방문일시"]),
      useDateText: useDateTime.dateText,
      useTimeText: useDateTime.timeText,
      quantity: extractValueAfterLabels(detailText, ["수량", "인원", "예약인원"]),
      paymentStatus: extractValueAfterLabels(detailText, ["결제상태", "결제 상태"]),
      priceText: extractValueAfterLabels(detailText, ["결제금액", "결제 금액", "결제금액 합계"]),
      visibleTextSample: detailText.slice(0, 1200),
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Naver booking detail RPA read failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
