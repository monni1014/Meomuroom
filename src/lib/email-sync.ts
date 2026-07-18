import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseEmail } from "./email-parser";
import { prisma } from "./prisma";
import { markEmailProcessed } from "./processed-email";
import {
  enqueueRpaEmailJobs,
  enqueueRpaSlotRecheck,
  isRpaEmailJobActive,
  type RpaEmailJob,
} from "./rpa-job-queue";
import { ensureRpaPendingReservation, RPA_PENDING_MARKER } from "./rpa-reservation-state";

type CollectedMail = {
  messageId: string;
  source: Buffer;
  uid: number;
  envelopeDate?: Date;
};

type EmailSyncGlobal = typeof globalThis & {
  __emailSyncRunning?: boolean;
};

const MAILBOX_NAME = "INBOX";

function getMailboxKey() {
  const account = (process.env.NAVER_EMAIL || "default").trim().toLowerCase();
  return `naver:${account}:${MAILBOX_NAME}`;
}

function copyRawSource(source: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
  bytes.set(source);
  return bytes;
}

async function findBootstrapUid(client: ImapFlow, uidNext: number) {
  const [processedRows, reservationRows] = await Promise.all([
    prisma.processedEmail.findMany({ select: { messageId: true } }),
    prisma.reservation.findMany({
      where: { emailId: { not: null } },
      select: { emailId: true },
    }),
  ]);
  const knownMessageIds = new Set<string>();
  for (const row of processedRows) knownMessageIds.add(row.messageId);
  for (const row of reservationRows) {
    if (row.emailId && !row.emailId.startsWith("naver:") && !row.emailId.startsWith("spacecloud:")) {
      knownMessageIds.add(row.emailId);
    }
  }

  let lastKnownUid = 0;
  if (knownMessageIds.size > 0 && uidNext > 1) {
    const messages = client.fetch("1:*", { uid: true, envelope: true }, { uid: true });
    for await (const message of messages) {
      const messageId = message.envelope?.messageId;
      if (messageId && knownMessageIds.has(messageId)) {
        lastKnownUid = Math.max(lastKnownUid, message.uid);
      }
    }
  }

  if (lastKnownUid > 0) {
    console.log(`[EmailSync] Persistent UID cursor bootstrapped from processed mail: uid=${lastKnownUid}`);
    return lastKnownUid;
  }

  if (knownMessageIds.size > 0) {
    console.warn(
      "[EmailSync] Existing processed mail could not be matched to a current UID. Replaying the mailbox safely.",
    );
    return 0;
  }

  // A brand-new installation has no history to match. Keep a short initial safety
  // window, then all future scans use UID and have no date limit.
  const initialSince = new Date();
  initialSince.setDate(initialSince.getDate() - 7);
  const recentUids = await client.search({ since: initialSince }, { uid: true });
  const firstRecentUid = recentUids && recentUids.length > 0 ? Math.min(...recentUids) : uidNext;
  const bootstrapUid = Math.max(0, firstRecentUid - 1);
  console.log(`[EmailSync] New mailbox cursor initialized at uid=${bootstrapUid}`);
  return bootstrapUid;
}

async function resolveLastCollectedUid(
  client: ImapFlow,
  mailboxKey: string,
  uidValidity: string,
  uidNext: number,
) {
  const cursor = await prisma.imapSyncCursor.findUnique({ where: { mailboxKey } });
  if (cursor?.uidValidity === uidValidity) return cursor.lastUid;

  if (cursor) {
    console.warn(
      `[EmailSync] INBOX UIDVALIDITY changed (${cursor.uidValidity} -> ${uidValidity}). Rebuilding cursor safely.`,
    );
  }

  const lastUid = await findBootstrapUid(client, uidNext);
  await prisma.imapSyncCursor.upsert({
    where: { mailboxKey },
    update: { uidValidity, lastUid },
    create: { mailboxKey, uidValidity, lastUid },
  });
  return lastUid;
}

async function stageNewEmails(
  client: ImapFlow,
  mailboxKey: string,
  uidValidity: string,
  lastCollectedUid: number,
  uidNext: number,
) {
  if (lastCollectedUid >= uidNext - 1) return { staged: 0, seenUids: [] as number[] };

  const fetched: CollectedMail[] = [];
  const range = `${lastCollectedUid + 1}:*`;
  const messages = client.fetch(range, { source: true, uid: true, envelope: true }, { uid: true });
  for await (const message of messages) {
    if (message.uid <= lastCollectedUid) continue;
    if (!message.source) {
      throw new Error(`IMAP message uid=${message.uid} has no source; cursor was not advanced.`);
    }

    fetched.push({
      messageId: message.envelope?.messageId || `uid-${uidValidity}-${message.uid}`,
      source: message.source,
      uid: message.uid,
      envelopeDate: message.envelope?.date,
    });
  }

  fetched.sort((a, b) => a.uid - b.uid);
  for (const mail of fetched) {
    const rawSource = copyRawSource(mail.source);
    await prisma.pendingImapEmail.upsert({
      where: { messageId: mail.messageId },
      update: {
        mailboxKey,
        uidValidity,
        uid: mail.uid,
        rawSource,
        envelopeDate: mail.envelopeDate,
      },
      create: {
        mailboxKey,
        uidValidity,
        uid: mail.uid,
        messageId: mail.messageId,
        rawSource,
        envelopeDate: mail.envelopeDate,
      },
    });
  }

  const highestFetchedUid = fetched.length > 0 ? fetched[fetched.length - 1].uid : lastCollectedUid;
  const highestCollectedUid = Math.max(highestFetchedUid, uidNext - 1);
  if (highestCollectedUid > lastCollectedUid) {
    await prisma.imapSyncCursor.update({
      where: { mailboxKey },
      data: { uidValidity, lastUid: highestCollectedUid },
    });
    console.log(
      `[EmailSync] Safely staged ${fetched.length} new mail(s), cursor=${highestCollectedUid}.`,
    );
  }

  return { staged: fetched.length, seenUids: fetched.map((mail) => mail.uid) };
}

function isDepositWaitingMail(subject: string, text: string) {
  return subject.includes("입금대기") || /결제상태\s*입금대기/.test(text);
}

export async function syncEmails(): Promise<{ processed: number; newReservations: number; queuedRpaJobs: number }> {
  const globalLock = globalThis as EmailSyncGlobal;
  if (globalLock.__emailSyncRunning) {
    console.log("[EmailSync] Previous sync is still running. Skip this request.");
    return { processed: 0, newReservations: 0, queuedRpaJobs: 0 };
  }
  globalLock.__emailSyncRunning = true;

  const mailboxKey = getMailboxKey();
  console.log(`[EmailSync] Sync start. mailbox=${mailboxKey}`);

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

  client.on("error", (err) => {
    console.error("[EmailSync] IMAP client error:", err.message);
  });

  let processed = 0;
  let newReservations = 0;
  let queuedRpaJobs = 0;
  const rpaJobs: RpaEmailJob[] = [];

  try {
    let imapConnected = false;
    try {
      await client.connect();
      imapConnected = true;
      console.log("[EmailSync] IMAP connected");

      const lock = await client.getMailboxLock(MAILBOX_NAME);
      try {
        if (!client.mailbox) throw new Error("INBOX mailbox metadata is unavailable.");

        const uidValidity = String(client.mailbox.uidValidity);
        const uidNext = client.mailbox.uidNext;
        const lastCollectedUid = await resolveLastCollectedUid(
          client,
          mailboxKey,
          uidValidity,
          uidNext,
        );
        console.log(`[EmailSync] Fetching uncollected mail. uid>${lastCollectedUid}`);

        const staged = await stageNewEmails(
          client,
          mailboxKey,
          uidValidity,
          lastCollectedUid,
          uidNext,
        );
        processed = staged.staged;

        if (staged.seenUids.length > 0) {
          await client.messageFlagsAdd({ uid: staged.seenUids.join(",") }, ["\\Seen"]);
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      console.error(
        "[EmailSync] IMAP collection failed. Continue with safely staged mail:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (imapConnected) {
        try {
          await client.logout();
        } catch (error) {
          console.log("[EmailSync] Logout error ignored:", error instanceof Error ? error.message : String(error));
        }
      } else {
        try {
          client.close();
        } catch {
          // ignore close errors
        }
      }
    }

    const pendingRows = await prisma.pendingImapEmail.findMany({
      where: { mailboxKey },
      orderBy: { createdAt: "asc" },
    });
    const collected: CollectedMail[] = pendingRows.map((mail) => ({
      messageId: mail.messageId,
      source: Buffer.from(mail.rawSource),
      uid: mail.uid,
      envelopeDate: mail.envelopeDate || undefined,
    }));
    console.log(`[EmailSync] Processing ${collected.length} safely staged mail(s).`);

    for (const mail of collected) {
      const { messageId } = mail;
      try {
        const parsedMail = await simpleParser(mail.source);
        const subject = parsedMail.subject || "";
        const text = parsedMail.text || "";
        const reservationData = parseEmail(subject, text, messageId);

      const stalePendingReservation = await prisma.reservation.findFirst({
        where: {
          emailId: messageId,
          memo: { contains: RPA_PENDING_MARKER },
        },
        select: { id: true },
      });

      const processedEmail = await prisma.processedEmail.findUnique({ where: { messageId } });
      if (processedEmail && !stalePendingReservation) {
        const shouldRetryProcessedCancellation =
          !processedEmail.reservationId
          && Boolean(reservationData?.isCancelled)
          && (reservationData?.source === "naver" || reservationData?.source === "spacecloud");

        if (!shouldRetryProcessedCancellation) {
          console.log(`[EmailSync] Already processed email ignored: ${messageId}`);
          await markEmailProcessed(messageId, processedEmail.source, processedEmail.reservationId);
          continue;
        }

        console.log(`[EmailSync] Reprocess processed cancellation without reservation link: ${messageId}`);
      }
      if (processedEmail && stalePendingReservation) {
        console.log(`[EmailSync] Requeue stale RPA pending email: ${messageId}, reservation=${stalePendingReservation.id}`);
      }

      if (isRpaEmailJobActive(messageId)) {
        console.log(`[EmailSync] RPA job already queued/running/cooling down: ${messageId}`);
        continue;
      }

      if (isDepositWaitingMail(subject, text)) {
        console.log(`[EmailSync] Deposit-waiting email ignored: ${subject}`);
        await markEmailProcessed(messageId, "naver");
        continue;
      }

      if (!reservationData) {
        console.log(`[EmailSync] Not a reservation email: ${subject}`);
        await markEmailProcessed(messageId, "other");
        continue;
      }

      const existing = await prisma.reservation.findUnique({ where: { emailId: messageId } });
      if (existing && !existing.memo?.includes(RPA_PENDING_MARKER)) {
        console.log(`[EmailSync] Reservation email already reflected: ${messageId}`);
        await markEmailProcessed(messageId, existing.source, existing.id);
        continue;
      }

      if (reservationData.source === "naver" || reservationData.source === "spacecloud") {
        const pending = await ensureRpaPendingReservation(
          reservationData,
          messageId,
          parsedMail.date || new Date(),
        );

        rpaJobs.push({
          messageId,
          source: reservationData.source,
          subject,
          text,
          html: parsedMail.html,
          parsedReservation: reservationData,
          receivedAt: parsedMail.date || new Date(),
        });
        console.log(`[EmailSync] Prepared ${reservationData.source} RPA job: ${messageId}, pending=${pending.id}`);
        continue;
      }

      if (reservationData.isCancelled) {
        const target = await prisma.reservation.findFirst({
          where: {
            roomName: reservationData.roomName,
            startTime: reservationData.startTime,
            customerName: reservationData.customerName,
            status: { not: "CANCELLED" },
          },
        });

        if (target) {
          const updated = await prisma.reservation.update({
            where: { id: target.id },
            data: {
              status: "CANCELLED",
              price: reservationData.refundFee ?? 0,
            },
          });
          await markEmailProcessed(messageId, reservationData.source, updated.id);
          newReservations += 1;
          console.log(`[EmailSync] Cancelled reservation reflected: ${updated.id}`);
        } else {
          await markEmailProcessed(messageId, reservationData.source);
          console.log(`[EmailSync] Cancellation target not found: ${reservationData.roomName} ${reservationData.customerName}`);
        }
        continue;
      }

        const created = await prisma.reservation.create({
          data: {
            source: reservationData.source,
            roomName: reservationData.roomName,
            customerName: reservationData.customerName,
            startTime: reservationData.startTime,
            endTime: reservationData.endTime,
            price: reservationData.price,
            discount: reservationData.discount ?? 0,
            emailId: reservationData.emailId,
            createdAt: parsedMail.date || new Date(),
            usageLog: {
              create: {
                headCount: reservationData.headCount,
                reservedHeadCount: reservationData.headCount,
                purpose: null,
              },
            },
          },
        });
        await markEmailProcessed(messageId, reservationData.source, created.id);
        newReservations += 1;
        console.log(`[EmailSync] Reservation created: ${created.id}`);
      } catch (error) {
        console.error(
          `[EmailSync] Staged mail processing failed; keep it for retry: ${messageId}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (rpaJobs.length > 0) {
      queuedRpaJobs = enqueueRpaEmailJobs(rpaJobs);
      console.log(`[EmailSync] Queued RPA batch: prepared=${rpaJobs.length}, accepted=${queuedRpaJobs}`);
    }
  } catch (error) {
    console.error("[EmailSync] Sync failed:", error);
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  } finally {
    enqueueRpaSlotRecheck();
    globalLock.__emailSyncRunning = false;
    console.log(
      `[EmailSync] Sync end. checked=${processed}, created/changed=${newReservations}, queuedRpa=${queuedRpaJobs}`,
    );
  }

  return { processed, newReservations, queuedRpaJobs };
}
