import { existsSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { launchRpaBrowser, newRpaContext } from "../rpa/lib/browser.mjs";
import { naverStorageStatePath, spaceCloudStorageStatePath } from "../rpa/lib/paths.mjs";

const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" }),
});

function dateFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return new Date(fallback);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is not a valid date: ${value}`);
  return parsed;
}

const START = dateFromEnv("CONTACT_BACKFILL_START", "2026-06-14T15:00:00.000Z"); // default: 2026-06-15 00:00 KST
const END = dateFromEnv("CONTACT_BACKFILL_END", "2026-06-21T15:00:00.000Z"); // default: 2026-06-22 00:00 KST
const MAIL_SINCE = dateFromEnv("CONTACT_BACKFILL_MAIL_SINCE", "2026-06-01T00:00:00.000Z");
const TARGET_NAME = process.env.CONTACT_BACKFILL_NAME?.trim() || null;

function normalizeMessageId(value) {
  return (value || "").trim().replace(/^<|>$/g, "");
}

function normalizeText(text) {
  return (text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function isMaskedName(name) {
  return !name || name.includes("*") || name.includes("네이버 예약") || name.includes("스페이스클라우드 예약");
}

function isMissingPhone(phone) {
  return !phone || !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone);
}

function normalizePhone(value) {
  if (!value) return null;
  const match = value.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  if (digits.length === 10) return digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  return match[0].trim();
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

function extractPhone(text) {
  return normalizePhone(text);
}

function extractBookingNumber(text) {
  const match = text.match(/\b\d{9,12}\b/);
  return match ? match[0] : null;
}

function extractNaverBookingId(mail) {
  const combined = `${mail.subject || ""}\n${mail.text || ""}\n${mail.html || ""}`;
  return combined.match(/booking-list-view\/bookings\/(\d{9,12})/)?.[1]
    || combined.match(/bookings\/(\d{9,12})/)?.[1]
    || combined.match(/\b\d{10}\b/)?.[0]
    || null;
}

function normalizeUrl(url) {
  return (url || "").replace(/&amp;/g, "&").trim();
}

function decodeUrl(url) {
  let decoded = normalizeUrl(url);
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function extractSpaceCloudBookingNumberFromUrl(url) {
  if (!url) return null;
  return decodeUrl(url).match(/\/reservation\/(\d+)\/?/i)?.[1] || null;
}

function extractSpaceCloudDetailUrl(mail) {
  const combined = `${mail.subject || ""}\n${mail.text || ""}\n${mail.html || ""}`;
  const hrefs = [...combined.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => normalizeUrl(match[1]))
    .filter((url) => /spacecloud/i.test(url));
  const href = hrefs.find((url) => extractSpaceCloudBookingNumberFromUrl(url));
  if (href) return href;

  const raw = combined.match(/https?:\/\/[^\s"'<>]*spacecloud[^\s"'<>]*/gi) || [];
  return raw.map(normalizeUrl).find((url) => extractSpaceCloudBookingNumberFromUrl(url)) || null;
}

async function fetchTargetMails(targetMessageIds) {
  const byId = new Map();
  const client = new ImapFlow({
    host: "imap.naver.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.NAVER_EMAIL || "",
      pass: process.env.NAVER_EMAIL_PASSWORD || "",
    },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const messages = client.fetch({ since: MAIL_SINCE }, { source: true, envelope: true, uid: true });
    for await (const message of messages) {
      const candidates = [
        message.envelope?.messageId,
        normalizeMessageId(message.envelope?.messageId),
      ].filter(Boolean);
      if (!candidates.some((id) => targetMessageIds.has(id))) continue;
      if (!message.source) continue;

      const parsed = await simpleParser(message.source);
      const key = candidates.find((id) => targetMessageIds.has(id));
      byId.set(key, {
        messageId: message.envelope?.messageId || parsed.messageId || `uid-${message.uid}`,
        subject: parsed.subject || "",
        text: parsed.text || "",
        html: parsed.html || "",
        date: parsed.date || null,
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return byId;
}

async function waitForNaverDetail(page, bookingId) {
  await page.waitForFunction((id) => {
    const text = document.body?.innerText || "";
    return text.includes("예약 상세정보")
      && text.includes(id)
      && /예약번호|전화번호|이용일시/.test(text);
  }, bookingId, { timeout: 30_000 });
}

async function readNaverDetail(page, bookingId) {
  const url = `https://partner.booking.naver.com/bizes/1473933/booking-list-view/bookings/${bookingId}`;
  await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await waitForNaverDetail(page, bookingId);

  const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
  const text = normalizeText(bodyText);
  const detailStart = text.lastIndexOf("예약 상세정보");
  const detailText = detailStart >= 0 ? text.slice(detailStart) : text;

  return {
    bookingNumber: extractValueAfterLabels(detailText, ["예약번호", "예약 번호"]) || extractBookingNumber(detailText) || bookingId,
    customerName: extractValueAfterLabels(detailText, ["예약자", "예약자명", "이름"]),
    phone: extractValueAfterLabels(detailText, ["전화번호", "휴대폰 번호", "연락처"]) || extractPhone(detailText),
    productName: extractValueAfterLabels(detailText, ["상품", "예약상품", "상품명"]),
  };
}

async function readSpaceCloudDetail(page, url) {
  await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const text = normalizeText(bodyText);

  return {
    currentUrl: page.url(),
    bookingNumber: extractValueAfterLabels(text, ["예약번호", "예약 번호", "주문번호", "결제번호"])?.match(/[A-Z0-9-]{6,}|\d{6,}/i)?.[0]
      || text.match(/\b\d{8,14}\b/)?.[0]
      || extractSpaceCloudBookingNumberFromUrl(page.url()),
    customerName: extractValueAfterLabels(text, ["예약자명", "신청자명", "이름"]),
    phone: extractPhone(extractValueAfterLabels(text, ["전화번호", "휴대폰번호", "휴대폰", "연락처", "예약자 연락처"]) || text),
  };
}

function updatePayloadForDetail(row, detail, nextEmailId) {
  const data = {};
  const cleanName = detail.customerName && !isMaskedName(detail.customerName) ? detail.customerName.trim() : null;
  const phone = normalizePhone(detail.phone);

  if (cleanName && (isMaskedName(row.customerName) || row.customerName !== cleanName)) data.customerName = cleanName;
  if (phone && isMissingPhone(row.phone)) data.phone = phone;
  if (nextEmailId && row.emailId !== nextEmailId) data.emailId = nextEmailId;
  return data;
}

async function main() {
  const rows = await prisma.reservation.findMany({
    where: {
      startTime: { gte: START, lt: END },
      emailId: { not: null },
      source: { in: ["naver", "spacecloud"] },
      OR: [
        { phone: null },
        { customerName: { contains: "*" } },
      ],
    },
    orderBy: { startTime: "asc" },
  });

  const targetRows = rows.filter((row) => (
    (isMaskedName(row.customerName) || isMissingPhone(row.phone))
    && (!TARGET_NAME || row.customerName === TARGET_NAME)
  ));
  const targetMessageIds = new Set();
  for (const row of targetRows) {
    if (!row.emailId) continue;
    if (/^(naver|spacecloud):/.test(row.emailId)) continue;
    targetMessageIds.add(row.emailId);
    targetMessageIds.add(normalizeMessageId(row.emailId));
  }

  console.log(JSON.stringify({
    range: `${START.toISOString()}~${END.toISOString()}`,
    targetName: TARGET_NAME,
    targetRows: targetRows.length,
    targetMessageIds: targetMessageIds.size,
  }, null, 2));

  const mails = await fetchTargetMails(targetMessageIds);
  console.log(`Fetched target mails: ${mails.size}`);

  const result = {
    updated: [],
    skipped: [],
    failed: [],
  };

  const naverTargets = targetRows.filter((row) => row.source === "naver");
  if (naverTargets.length > 0) {
    if (!existsSync(naverStorageStatePath)) throw new Error("Naver login session is missing.");
    const browser = await launchRpaBrowser({ headless: false });
    try {
      const context = await newRpaContext(browser, { storageState: naverStorageStatePath, blockHeavyResources: true });
      const page = await context.newPage();

      for (const row of naverTargets) {
        try {
          const mail = mails.get(row.emailId) || mails.get(normalizeMessageId(row.emailId));
          const bookingId = mail ? extractNaverBookingId(mail) : row.emailId?.match(/^naver:(\d+)$/)?.[1];
          if (!bookingId) {
            result.skipped.push({ id: row.id, source: row.source, name: row.customerName, reason: "Naver booking id not found in mail" });
            continue;
          }

          const detail = await readNaverDetail(page, bookingId);
          const data = updatePayloadForDetail(row, detail, `naver:${detail.bookingNumber || bookingId}`);
          if (Object.keys(data).length === 0) {
            result.skipped.push({ id: row.id, source: row.source, name: row.customerName, bookingId, reason: "No data changes" });
            continue;
          }

          const updated = await prisma.reservation.update({
            where: { id: row.id },
            data,
          });
          result.updated.push({
            id: updated.id,
            source: updated.source,
            nameBefore: row.customerName,
            nameAfter: updated.customerName,
            phoneAfter: updated.phone,
            bookingId,
          });
        } catch (error) {
          result.failed.push({ id: row.id, source: row.source, name: row.customerName, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      await browser.close();
    }
  }

  const spaceTargets = targetRows.filter((row) => row.source === "spacecloud");
  if (spaceTargets.length > 0) {
    if (!existsSync(spaceCloudStorageStatePath)) throw new Error("SpaceCloud login session is missing.");
    const browser = await launchRpaBrowser({ headless: false });
    try {
      const context = await newRpaContext(browser, { storageState: spaceCloudStorageStatePath, blockHeavyResources: true });
      const page = await context.newPage();

      for (const row of spaceTargets) {
        try {
          const mail = mails.get(row.emailId) || mails.get(normalizeMessageId(row.emailId));
          const detailUrl = mail ? extractSpaceCloudDetailUrl(mail) : null;
          if (!detailUrl) {
            result.skipped.push({ id: row.id, source: row.source, name: row.customerName, reason: "SpaceCloud detail URL not found in mail" });
            continue;
          }

          const detail = await readSpaceCloudDetail(page, detailUrl);
          const nextEmailId = detail.bookingNumber ? `spacecloud:${detail.bookingNumber}` : undefined;
          const data = updatePayloadForDetail(row, detail, nextEmailId);
          if (Object.keys(data).length === 0) {
            result.skipped.push({ id: row.id, source: row.source, name: row.customerName, detailUrl, reason: "No data changes" });
            continue;
          }

          const updated = await prisma.reservation.update({
            where: { id: row.id },
            data,
          });
          result.updated.push({
            id: updated.id,
            source: updated.source,
            nameBefore: row.customerName,
            nameAfter: updated.customerName,
            phoneAfter: updated.phone,
            detailUrl,
          });
        } catch (error) {
          result.failed.push({ id: row.id, source: row.source, name: row.customerName, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      await browser.close();
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
