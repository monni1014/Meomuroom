import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseEmail } from "./email-parser";
import { prisma } from "./prisma";
import { enqueueRpaEmailJob, enqueueRpaSlotRecheck, isRpaEmailJobActive } from "./rpa-job-queue";
import { ensureRpaPendingReservation, RPA_PENDING_MARKER } from "./rpa-reservation-state";

type CollectedMail = {
  messageId: string;
  source: Buffer;
  uid: number;
  envelopeDate?: Date;
};

type EmailSyncGlobal = typeof globalThis & {
  __emailSyncRunning?: boolean;
  __emailSyncSinceDate?: Date;
};

async function markEmailProcessed(messageId: string, source?: string | null, reservationId?: string | null) {
  await prisma.processedEmail.upsert({
    where: { messageId },
    update: {
      source: source || undefined,
      reservationId: reservationId || undefined,
    },
    create: {
      messageId,
      source: source || undefined,
      reservationId: reservationId || undefined,
    },
  });
}

function getSyncSinceDate(startedAt: Date) {
  const globalLock = globalThis as EmailSyncGlobal;
  if (globalLock.__emailSyncSinceDate) {
    return new Date(globalLock.__emailSyncSinceDate.getTime() - 5 * 60 * 1000);
  }

  const sinceDate = new Date(startedAt);
  sinceDate.setDate(sinceDate.getDate() - 3);
  return sinceDate;
}

async function includeStaleRpaPendingSinceDate(baseSinceDate: Date) {
  const pendingRows = await prisma.reservation.findMany({
    where: {
      memo: { contains: RPA_PENDING_MARKER },
      emailId: { not: null },
    },
    select: {
      id: true,
      emailId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  const emailBackedPending = pendingRows.find((row) => {
    const emailId = row.emailId || "";
    return emailId.length > 0 && !emailId.startsWith("naver:") && !emailId.startsWith("spacecloud:");
  });

  if (!emailBackedPending) return baseSinceDate;

  const maxLookback = new Date();
  maxLookback.setDate(maxLookback.getDate() - 3);

  const pendingSinceDate = new Date(emailBackedPending.createdAt.getTime() - 10 * 60 * 1000);
  const boundedPendingSinceDate = pendingSinceDate < maxLookback ? maxLookback : pendingSinceDate;

  if (boundedPendingSinceDate < baseSinceDate) {
    console.log(
      `[EmailSync] Extending sync range for stale RPA pending reservation ${emailBackedPending.id}: ${baseSinceDate.toISOString()} -> ${boundedPendingSinceDate.toISOString()}`,
    );
    return boundedPendingSinceDate;
  }

  return baseSinceDate;
}

function rememberNextSyncSinceDate(startedAt: Date, collected: CollectedMail[]) {
  const globalLock = globalThis as EmailSyncGlobal;
  const latestEnvelopeDate = collected
    .map((mail) => mail.envelopeDate?.getTime() || 0)
    .reduce((max, value) => Math.max(max, value), 0);

  globalLock.__emailSyncSinceDate = new Date(Math.max(startedAt.getTime(), latestEnvelopeDate));
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

  const startedAt = new Date();
  let sinceDate = getSyncSinceDate(startedAt);
  sinceDate = await includeStaleRpaPendingSinceDate(sinceDate);
  console.log(`[EmailSync] Sync start. since=${sinceDate.toISOString()}`);

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
  const collected: CollectedMail[] = [];
  const seenUids: number[] = [];

  try {
    await client.connect();
    console.log("[EmailSync] IMAP connected");

    const lock = await client.getMailboxLock("INBOX");
    try {
      console.log("[EmailSync] Fetching recent mails...");
      const messages = client.fetch({ since: sinceDate }, { source: true, uid: true, envelope: true });

      for await (const message of messages) {
        processed += 1;
        const messageId = message.envelope?.messageId || `uid-${message.uid}`;
        if (!message.source) {
          console.log(`[EmailSync] Mail has no source. skip: ${messageId}`);
          continue;
        }

        collected.push({
          messageId,
          source: message.source,
          uid: message.uid,
          envelopeDate: message.envelope?.date,
        });
        seenUids.push(message.uid);
      }

      if (seenUids.length > 0) {
        await client.messageFlagsAdd({ uid: seenUids.join(",") }, ["\\Seen"]);
      }
    } finally {
      lock.release();
    }

    try {
      await client.logout();
    } catch (error) {
      console.log("[EmailSync] Logout error ignored:", error instanceof Error ? error.message : String(error));
    }

    rememberNextSyncSinceDate(startedAt, collected);

    for (const mail of collected) {
      const { messageId } = mail;
      const parsedMail = await simpleParser(mail.source);
      const subject = parsedMail.subject || "";
      const text = parsedMail.text || "";

      const stalePendingReservation = await prisma.reservation.findFirst({
        where: {
          emailId: messageId,
          memo: { contains: RPA_PENDING_MARKER },
        },
        select: { id: true },
      });

      const processedEmail = await prisma.processedEmail.findUnique({ where: { messageId } });
      if (processedEmail && !stalePendingReservation) {
        console.log(`[EmailSync] Already processed email ignored: ${messageId}`);
        continue;
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

      const reservationData = parseEmail(subject, text, messageId);
      if (!reservationData) {
        console.log(`[EmailSync] Not a reservation email: ${subject}`);
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

        const queued = enqueueRpaEmailJob({
          messageId,
          source: reservationData.source,
          subject,
          text,
          html: parsedMail.html,
          parsedReservation: reservationData,
          receivedAt: parsedMail.date || new Date(),
        });

        if (queued) {
          queuedRpaJobs += 1;
          console.log(`[EmailSync] Queued ${reservationData.source} RPA job: ${messageId}, pending=${pending.id}`);
        }
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
