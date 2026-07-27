import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { parseNaverEmail } from "../src/lib/email-parser.ts";

const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" }),
});

const APPLY = process.env.REVIEW_BACKFILL_APPLY === "1";
const RESERVATION_START = new Date(process.env.REVIEW_BACKFILL_START || "2026-06-30T15:00:00.000Z");
const RESERVATION_END = new Date(process.env.REVIEW_BACKFILL_END || "2026-07-31T15:00:00.000Z");
const MAIL_SINCE = new Date(process.env.REVIEW_BACKFILL_MAIL_SINCE || "2026-01-01T00:00:00.000Z");
const MAIL_BEFORE = new Date(process.env.REVIEW_BACKFILL_MAIL_BEFORE || "2026-08-01T00:00:00.000Z");

function normalizeMessageId(value) {
  return (value || "").trim().replace(/^<|>$/g, "");
}

function isTargetReservation(parsed) {
  return parsed
    && parsed.source === "naver"
    && !parsed.isCancelled
    && parsed.startTime >= RESERVATION_START
    && parsed.startTime < RESERVATION_END;
}

function hasReviewRequest(parsed) {
  return Boolean(parsed.visitorReviewRequested || parsed.blogReviewRequested);
}

async function main() {
  if (!process.env.NAVER_EMAIL || !process.env.NAVER_EMAIL_PASSWORD) {
    throw new Error("Naver IMAP credentials are not configured.");
  }

  const [julyReservations, processedEmails] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        source: "naver",
        startTime: { gte: RESERVATION_START, lt: RESERVATION_END },
      },
      select: {
        id: true,
        emailId: true,
        roomName: true,
        customerName: true,
        startTime: true,
        visitorReviewRequested: true,
        blogReviewRequested: true,
      },
    }),
    prisma.processedEmail.findMany({
      where: { source: "naver", reservationId: { not: null } },
      select: { messageId: true, reservationId: true },
    }),
  ]);

  const reservationById = new Map(julyReservations.map((row) => [row.id, row]));
  const reservationByEmailId = new Map();
  for (const row of julyReservations) {
    if (!row.emailId) continue;
    reservationByEmailId.set(row.emailId, row);
    reservationByEmailId.set(normalizeMessageId(row.emailId), row);
  }
  const processedByMessageId = new Map();
  for (const row of processedEmails) {
    processedByMessageId.set(row.messageId, row.reservationId);
    processedByMessageId.set(normalizeMessageId(row.messageId), row.reservationId);
  }

  const client = new ImapFlow({
    host: "imap.naver.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.NAVER_EMAIL,
      pass: process.env.NAVER_EMAIL_PASSWORD,
    },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  const stats = {
    scanned: 0,
    julyNaverReservationMails: 0,
    reviewMails: 0,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    visitorUpdates: 0,
    blogUpdates: 0,
  };
  const plannedByReservationId = new Map();

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const messages = client.fetch(
      { since: MAIL_SINCE, before: MAIL_BEFORE },
      { source: true, envelope: true, uid: true },
    );

    for await (const message of messages) {
      stats.scanned += 1;
      if (!message.source) continue;

      const mail = await simpleParser(message.source);
      const messageId = mail.messageId || message.envelope?.messageId || `uid-${message.uid}`;
      const parsed = parseNaverEmail(mail.subject || "", mail.text || "", messageId);
      if (!isTargetReservation(parsed)) continue;
      stats.julyNaverReservationMails += 1;
      if (!hasReviewRequest(parsed)) continue;
      stats.reviewMails += 1;

      const messageIdCandidates = [
        messageId,
        normalizeMessageId(messageId),
        message.envelope?.messageId,
        normalizeMessageId(message.envelope?.messageId),
      ].filter(Boolean);

      let reservation = null;
      for (const candidate of messageIdCandidates) {
        const reservationId = processedByMessageId.get(candidate);
        if (reservationId && reservationById.has(reservationId)) {
          reservation = reservationById.get(reservationId);
          break;
        }
        if (reservationByEmailId.has(candidate)) {
          reservation = reservationByEmailId.get(candidate);
          break;
        }
      }

      if (!reservation) {
        const candidates = julyReservations.filter((row) => (
          row.roomName === parsed.roomName
          && Math.abs(row.startTime.getTime() - parsed.startTime.getTime()) < 60_000
        ));
        if (candidates.length === 1) reservation = candidates[0];
        else if (candidates.length > 1) stats.ambiguous += 1;
      }

      if (!reservation) {
        stats.unmatched += 1;
        continue;
      }

      stats.matched += 1;
      const currentPlan = plannedByReservationId.get(reservation.id) || {
        reservation,
        visitorReviewRequested: false,
        blogReviewRequested: false,
      };
      currentPlan.visitorReviewRequested ||= Boolean(parsed.visitorReviewRequested);
      currentPlan.blogReviewRequested ||= Boolean(parsed.blogReviewRequested);
      plannedByReservationId.set(reservation.id, currentPlan);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  const updates = [];
  for (const plan of plannedByReservationId.values()) {
    const data = {};
    if (plan.visitorReviewRequested && !plan.reservation.visitorReviewRequested) {
      data.visitorReviewRequested = true;
      stats.visitorUpdates += 1;
    }
    if (plan.blogReviewRequested && !plan.reservation.blogReviewRequested) {
      data.blogReviewRequested = true;
      stats.blogUpdates += 1;
    }
    if (Object.keys(data).length > 0) updates.push({ id: plan.reservation.id, data });
  }

  if (APPLY && updates.length > 0) {
    await prisma.$transaction(
      updates.map((update) => prisma.reservation.update({ where: { id: update.id }, data: update.data })),
    );
  }

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    reservationRange: [RESERVATION_START.toISOString(), RESERVATION_END.toISOString()],
    mailRange: [MAIL_SINCE.toISOString(), MAIL_BEFORE.toISOString()],
    julyReservationRows: julyReservations.length,
    ...stats,
    changedReservations: updates.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error("July review request backfill failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
