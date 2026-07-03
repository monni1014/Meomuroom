import type { ParsedReservation } from "./email-parser";
import { processNaverEmailWithRpa, recheckNaverSlotRpaIssues } from "./naver-rpa-sync";
import { prisma } from "./prisma";
import { markRpaJobCheckRequired } from "./rpa-reservation-state";
import { processSpaceCloudEmailWithRpa } from "./spacecloud-rpa-sync";

type RpaEmailJob = {
  messageId: string;
  source: "naver" | "spacecloud";
  subject: string;
  text: string;
  html?: string | false;
  parsedReservation: ParsedReservation;
  receivedAt?: Date;
};

type RpaQueueState = {
  queue: RpaEmailJob[];
  activeIds: Set<string>;
  failedUntil: Map<string, number>;
  failureCounts: Map<string, number>;
  manualCheckIds: Set<string>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  running: boolean;
  slotRecheckRunning: boolean;
  lastSlotRecheckAt: number;
};

type RpaQueueGlobal = typeof globalThis & {
  __memoroomRpaQueue?: RpaQueueState;
};

const FAILED_RETRY_COOLDOWNS_MS = [60 * 1000, 2 * 60 * 1000] as const;
const MAX_AUTO_FAILURES = 3;
const SLOT_RECHECK_COOLDOWN_MS = 10 * 60 * 1000;

function getState() {
  const g = globalThis as RpaQueueGlobal;
  g.__memoroomRpaQueue ??= {
    queue: [],
    activeIds: new Set<string>(),
    failedUntil: new Map<string, number>(),
    failureCounts: new Map<string, number>(),
    manualCheckIds: new Set<string>(),
    retryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    running: false,
    slotRecheckRunning: false,
    lastSlotRecheckAt: 0,
  };
  return g.__memoroomRpaQueue;
}

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

function clearRetryTimer(state: RpaQueueState, messageId: string) {
  const timer = state.retryTimers.get(messageId);
  if (timer) clearTimeout(timer);
  state.retryTimers.delete(messageId);
}

function scheduleRetry(state: RpaQueueState, job: RpaEmailJob, retryDelay: number) {
  clearRetryTimer(state, job.messageId);

  const timer = setTimeout(() => {
    state.retryTimers.delete(job.messageId);
    state.failedUntil.delete(job.messageId);

    if (state.manualCheckIds.has(job.messageId) || state.activeIds.has(job.messageId)) return;

    state.queue.push(job);
    state.activeIds.add(job.messageId);
    void drainRpaEmailQueue();
  }, retryDelay);

  state.retryTimers.set(job.messageId, timer);
}

export function isRpaEmailJobActive(messageId: string) {
  const state = getState();
  if (state.manualCheckIds.has(messageId)) return true;
  if (state.retryTimers.has(messageId)) return true;
  const retryAt = state.failedUntil.get(messageId);
  if (retryAt && retryAt > Date.now()) return true;
  if (retryAt) state.failedUntil.delete(messageId);
  return state.activeIds.has(messageId);
}

export function enqueueRpaEmailJob(job: RpaEmailJob) {
  const state = getState();
  if (isRpaEmailJobActive(job.messageId)) return false;

  state.queue.push(job);
  state.activeIds.add(job.messageId);
  void drainRpaEmailQueue();
  return true;
}

async function drainRpaEmailQueue() {
  const state = getState();
  if (state.running) return;

  state.running = true;
  try {
    while (state.queue.length > 0) {
      const job = state.queue.shift();
      if (!job) continue;

      try {
        console.log(`[RPAQueue] Start ${job.source} job: ${job.messageId}`);
        if (job.source === "naver") {
          await processNaverEmailWithRpa(job);
        } else {
          await processSpaceCloudEmailWithRpa(job);
        }
        await markEmailProcessed(job.messageId, job.source);
        state.failedUntil.delete(job.messageId);
        state.failureCounts.delete(job.messageId);
        state.manualCheckIds.delete(job.messageId);
        clearRetryTimer(state, job.messageId);
        console.log(`[RPAQueue] Done ${job.source} job: ${job.messageId}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failureCount = (state.failureCounts.get(job.messageId) || 0) + 1;
        state.failureCounts.set(job.messageId, failureCount);

        if (failureCount >= MAX_AUTO_FAILURES) {
          await markRpaJobCheckRequired(
            job.parsedReservation,
            job.messageId,
            `${job.source} RPA failed ${failureCount} times: ${reason}`,
            job.receivedAt,
          );
          state.manualCheckIds.add(job.messageId);
          state.failedUntil.delete(job.messageId);
          clearRetryTimer(state, job.messageId);
          console.error(
            `[RPAQueue] Failed ${job.source} job ${failureCount} times. Manual check required: ${job.messageId}`,
            reason,
          );
        } else {
          const retryDelay = FAILED_RETRY_COOLDOWNS_MS[Math.min(failureCount - 1, FAILED_RETRY_COOLDOWNS_MS.length - 1)];
          state.failedUntil.set(job.messageId, Date.now() + retryDelay);
          scheduleRetry(state, job, retryDelay);
          console.error(
            `[RPAQueue] Failed ${job.source} job: ${job.messageId}. Retry in ${Math.round(retryDelay / 1000)}s`,
            reason,
          );
        }
      } finally {
        state.activeIds.delete(job.messageId);
      }
    }
  } finally {
    state.running = false;
  }
}

export function enqueueRpaSlotRecheck() {
  const state = getState();
  const now = Date.now();
  if (state.slotRecheckRunning) return false;
  if (now - state.lastSlotRecheckAt < SLOT_RECHECK_COOLDOWN_MS) return false;

  state.slotRecheckRunning = true;
  state.lastSlotRecheckAt = now;
  void (async () => {
    try {
      const result = await recheckNaverSlotRpaIssues(1);
      if (result.checked > 0) {
        console.log(`[RPAQueue] Slot recheck done: checked ${result.checked}, resolved ${result.resolved}`);
      }
    } catch (error) {
      console.error("[RPAQueue] Slot recheck failed:", error);
    } finally {
      state.slotRecheckRunning = false;
    }
  })();

  return true;
}

export function getRpaQueueStatus() {
  const state = getState();
  return {
    queued: state.queue.length,
    activeOrCoolingDown: state.activeIds.size + state.failedUntil.size + state.manualCheckIds.size + state.retryTimers.size,
    running: state.running,
    slotRecheckRunning: state.slotRecheckRunning,
  };
}
