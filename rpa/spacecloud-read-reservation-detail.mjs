import { existsSync } from "node:fs";
import { launchRpaBrowser, newRpaContext, resolveRpaHeadless } from "./lib/browser.mjs";
import { parseArgs, requiredArg } from "./lib/cli.mjs";
import { humanDelay, humanMouseMove } from "./lib/human.mjs";
import { spaceCloudStorageStatePath } from "./lib/paths.mjs";
import { saveScreenshot } from "./lib/screenshot.mjs";
import { spaceCloudBrowserOptions } from "./lib/spacecloud-session.mjs";

function normalizeText(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function extractPhone(text) {
  const match = text.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  if (digits.length === 10) return digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  return match[0].trim();
}

function parseAmount(value) {
  if (!value) return 0;
  return Number(value.replace(/[^\d]/g, "")) || 0;
}

function extractValueAfterLabels(text, labels) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const sortedLabels = [...labels].sort((a, b) => b.length - a.length);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of sortedLabels) {
      if (line === label && lines[i + 1]) return lines[i + 1].trim();
      if (line.startsWith(label)) {
        const value = line.slice(label.length).replace(/^[:：\s]+/, "").trim();
        if (!value || ["정보", "관리", "보기"].includes(value)) continue;
        if (value) return value;
      }
    }
  }

  return null;
}

function extractAmountAfterLabels(text, labels) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (line.includes(label)) {
        const sameLine = line.slice(line.indexOf(label) + label.length);
        const sameLineAmount = sameLine.match(/[\d,]+\s*원/);
        if (sameLineAmount) return parseAmount(sameLineAmount[0]);

        for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
          const nextAmount = lines[j].match(/[\d,]+\s*원/);
          if (nextAmount) return parseAmount(nextAmount[0]);
        }
      }
    }
  }

  return 0;
}

function hasAnyLabel(text, labels) {
  return labels.some((label) => text.includes(label));
}

function extractRefundFeeInfo(text) {
  const directFeeLabels = ["취소수수료", "취소 수수료", "환불수수료", "환불 수수료", "위약금"];
  const paymentLabels = ["결제예정금액", "결제 예정 금액", "결제금액", "결제 금액", "총 결제금액", "최종 결제금액"];
  const refundAmountLabels = ["환불금액", "환불 금액", "환불예정금액", "환불 예정 금액"];

  if (hasAnyLabel(text, directFeeLabels)) {
    return {
      refundFee: extractAmountAfterLabels(text, directFeeLabels),
      refundFeeFound: true,
      refundFeeSource: "direct_fee",
      paymentAmount: null,
      refundAmount: null,
    };
  }

  const paymentFound = hasAnyLabel(text, paymentLabels);
  const refundFound = hasAnyLabel(text, refundAmountLabels);
  if (paymentFound && refundFound) {
    const paymentAmount = extractAmountAfterLabels(text, paymentLabels);
    const refundAmount = extractAmountAfterLabels(text, refundAmountLabels);
    return {
      refundFee: Math.max(0, paymentAmount - refundAmount),
      refundFeeFound: true,
      refundFeeSource: "payment_minus_refund",
      paymentAmount,
      refundAmount,
    };
  }

  return {
    refundFee: 0,
    refundFeeFound: false,
    refundFeeSource: null,
    paymentAmount: null,
    refundAmount: null,
  };
}

function extractStatus(text) {
  const status = extractValueAfterLabels(text, ["예약상태", "상태", "진행상태"]);
  if (status) return status;
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => /취소\/환불 완료|예약취소 완료|취소 완료/.test(line))) return "취소";
  if (/취소일자|환불금액/.test(text)) return "취소";
  if (lines.some((line) => /^예약\s*확정$|^확정$/.test(line))) return "확정";
  return null;
}

function extractBookingNumber(text) {
  const labeled = extractValueAfterLabels(text, ["예약번호", "예약 번호", "주문번호", "결제번호"]);
  if (labeled) {
    const match = labeled.match(/[A-Z0-9-]{6,}|\d{6,}/i);
    if (match) return match[0];
  }
  return text.match(/\b\d{8,14}\b/)?.[0] || null;
}

function extractBookingNumberFromUrl(url) {
  return url.match(/\/reservation\/(\d+)\/?/i)?.[1] || null;
}

async function waitForDetailContent(page, bookingNumber, timeout = 55_000) {
  await page.waitForFunction(
    (targetBookingNumber) => {
      const text = document.body?.innerText || "";
      const compact = text.replace(/\s+/g, "");
      const hasBookingNumber = !targetBookingNumber || compact.includes(targetBookingNumber);
      const hasDetailHint = /(?:\uC608\uC57D|\uACF5\uAC04|\uACB0\uC81C|\uC5F0\uB77D\uCC98|\uC608\uC57D\uC790)/.test(text);

      return hasBookingNumber && hasDetailHint;
    },
    bookingNumber,
    { timeout },
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const url = requiredArg(args, "url");
  const bookingNumberFromUrl = extractBookingNumberFromUrl(url);

  if (!existsSync(spaceCloudStorageStatePath)) {
    throw new Error("SpaceCloud login session is missing. Run `npm run rpa:spacecloud-login` first.");
  }

  const headless = resolveRpaHeadless();
  const browserOptions = spaceCloudBrowserOptions(headless);
  console.log(`[SpaceCloud network] Use ${browserOptions.useProxy ? "proxy" : "direct"} session path.`);
  const browser = await launchRpaBrowser(browserOptions);

  try {
    const context = await newRpaContext(browser, {
      storageState: spaceCloudStorageStatePath,
      blockHeavyResources: true,
      rpaRole: "spacecloud",
    });
    const page = await context.newPage();

    console.log(`Open SpaceCloud detail: ${url}`);
    await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await humanDelay(page, "after detail open", 3200, 7200);
    await humanMouseMove(page, 720, 420, "SpaceCloud detail read");

    await waitForDetailContent(page, bookingNumberFromUrl, 55_000).catch(async () => {
      console.log("SpaceCloud detail content was not ready. Reload once before parsing.");
      await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
      await humanDelay(page, "after detail reload", 3200, 7200);
      await humanMouseMove(page, 760, 460, "SpaceCloud detail retry read");
      await waitForDetailContent(page, bookingNumberFromUrl, 55_000);
    });

    const firstBodyText = await page.evaluate(() => document.body?.innerText || "");
    if (!extractPhone(firstBodyText)) {
      console.log("SpaceCloud phone was not visible after initial load. Reload once before final parse.");
      await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
      await humanDelay(page, "after phone retry reload", 3200, 7200);
      await humanMouseMove(page, 700, 500, "SpaceCloud phone retry read");
      await waitForDetailContent(page, bookingNumberFromUrl, 55_000).catch(() => {});
    }

    const screenshot = await saveScreenshot(page, "spacecloud-detail-read");
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const text = normalizeText(bodyText);

    const refundInfo = extractRefundFeeInfo(text);
    const result = {
      currentUrl: page.url(),
      screenshot,
      bookingStatus: extractStatus(text),
      bookingNumber: extractBookingNumber(text),
      customerName: extractValueAfterLabels(text, ["예약자명", "신청자명", "이름"]),
      phone: extractPhone(extractValueAfterLabels(text, ["전화번호", "휴대폰번호", "휴대폰", "연락처", "예약자 연락처"]) || text),
      productName: extractValueAfterLabels(text, ["예약공간", "공간명", "상품명"]),
      useDateTime: extractValueAfterLabels(text, ["예약내용", "이용일시", "예약일시", "이용 시간", "예약 시간"]),
      quantity: extractValueAfterLabels(text, ["예약인원", "이용인원", "인원수", "인원"]),
      priceText: extractValueAfterLabels(text, ["결제금액", "결제 금액", "총 결제금액", "최종 결제금액"]),
      refundFee: refundInfo.refundFee,
      refundFeeFound: refundInfo.refundFeeFound,
      refundFeeSource: refundInfo.refundFeeSource,
      paymentAmount: refundInfo.paymentAmount,
      refundAmount: refundInfo.refundAmount,
      visibleTextSample: text.slice(0, 1600),
    };

    const statusText = result.bookingStatus || "";
    const canMissPhone = /취소|환불|이용완료/.test(statusText);
    if (!result.phone && !canMissPhone) {
      throw new Error("SpaceCloud detail phone number was not visible after retry.");
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("SpaceCloud detail RPA read failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
