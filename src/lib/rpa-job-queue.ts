import type { ParsedReservation } from "./email-parser";
import {
  processNaverEmailWithRpa,
  reconcileNaverReservationsWithoutCancelEmail,
  recheckNaverSlotRpaIssues,
} from "./naver-rpa-sync";
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
  supersededConfirmationJobs?: RpaEmailJob[];
};

type RpaQueueState = {
  queue: RpaEmailJob[];
  activeIds: Set<string>;
  failedUntil: Map<string, number>;
  failureCounts: Map<string, number>;
  manualCheckIds: Set<string>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  retryJobs: Map<string, RpaEmailJob>;
  supersededConfirmationIds: Set<string>;
  running: boolean;
  currentJob?: RpaEmailJob;
  slotRecheckRunning: boolean;
  lastSlotRecheckAt: number;
  naverStatusReconcileRunning: boolean;
  lastNaverStatusReconcileAt: number;
};

type RpaQueueGlobal = typeof globalThis & {
  __memoroomRpaQueue?: RpaQueueState;
};

const FAILED_RETRY_COOLDOWNS_MS = [60 * 1000, 2 * 60 * 1000] as const;
const MAX_AUTO_FAILURES = 3;
const SLOT_RECHECK_COOLDOWN_MS = 10 * 60 * 1000;

function isCancellationJob(job: RpaEmailJob) {
  return Boolean(job.parsedReservation.isCancelled);
}

function extractJobBookingKey(job: RpaEmailJob) {
  const combined = `${job.subject}\n${job.text}\n${job.html || ""}`;

  if (job.source === "naver") {
    const match = combined.match(/booking-list-view\/bookings\/(\d{9,12})/);
    return match ? `naver:${match[1]}` : null;
  }

  const normalized = combined.replace(/&amp;/g, "&");
  const match = normalized.match(/partner\.spacecloud\.kr\/reservation\/(\d+)\/?/i);
  return match ? `spacecloud:${match[1]}` : null;
}

function isSameReservationWindow(a: RpaEmailJob, b: RpaEmailJob) {
  return a.source === b.source
    && a.parsedReservation.roomName === b.parsedReservation.roomName
    && a.parsedReservation.startTime.getTime() === b.parsedReservation.startTime.getTime()
    && a.parsedReservation.endTime.getTime() === b.parsedReservation.endTime.getTime();
}

function isSameQueuedReservation(a: RpaEmailJob, b: RpaEmailJob) {
  if (a.source !== b.source) return false;

  const aBookingKey = extractJobBookingKey(a);
  const bBookingKey = extractJobBookingKey(b);
  if (aBookingKey || bBookingKey) {
    return Boolean(aBookingKey && bBookingKey && aBookingKey === bBookingKey);
  }

  return isSameReservationWindow(a, b);
}

function attachSupersededConfirmationJob(state: RpaQueueState, cancelJob: RpaEmailJob, confirmationJob: RpaEmailJob) {
  cancelJob.supersededConfirmationJobs ??= [];
  if (!cancelJob.supersededConfirmationJobs.some((job) => job.messageId === confirmationJob.messageId)) {
    cancelJob.supersededConfirmationJobs.push(confirmationJob);
  }

  state.supersededConfirmationIds.add(confirmationJob.messageId);
  state.activeIds.delete(confirmationJob.messageId);
  state.failedUntil.delete(confirmationJob.messageId);
  state.failureCounts.delete(confirmationJob.messageId);
  clearRetryTimer(state, confirmationJob.messageId);
}

function removeQueuedConfirmationForCancellation(state: RpaQueueState, cancelJob: RpaEmailJob) {
  if (!isCancellationJob(cancelJob)) return [];

  const removedMessageIds = new Set<string>();
  state.queue = state.queue.filter((queuedJob) => {
    const remove = !isCancellationJob(queuedJob) && isSameQueuedReservation(queuedJob, cancelJob);
    if (remove) {
      removedMessageIds.add(queuedJob.messageId);
      attachSupersededConfirmationJob(state, cancelJob, queuedJob);
    }
    return !remove;
  });

  for (const retryJob of [...state.retryJobs.values()]) {
    const remove = !isCancellationJob(retryJob) && isSameQueuedReservation(retryJob, cancelJob);
    if (remove) {
      removedMessageIds.add(retryJob.messageId);
      attachSupersededConfirmationJob(state, cancelJob, retryJob);
    }
  }

  if (removedMessageIds.size > 0) {
    console.log(
      `[RPAQueue] Removed queued confirmation jobs because cancellation arrived: ${[...removedMessageIds].join(", ")}`,
    );
  }

  return [...removedMessageIds];
}

function findCancellationToOwnConfirmation(state: RpaQueueState, confirmationJob: RpaEmailJob) {
  if (isCancellationJob(confirmationJob)) return null;

  if (
    state.currentJob
    && isCancellationJob(state.currentJob)
    && isSameQueuedReservation(state.currentJob, confirmationJob)
  ) {
    return state.currentJob;
  }

  return state.queue.find((queuedJob) =>
    isCancellationJob(queuedJob) && isSameQueuedReservation(queuedJob, confirmationJob)
  ) || null;
}

function pushJobByPriority(state: RpaQueueState, job: RpaEmailJob) {
  if (isCancellationJob(job)) {
    removeQueuedConfirmationForCancellation(state, job);
    state.queue.push(job);
    console.log(`[RPAQueue] Queued cancellation job after pending confirmations: ${job.messageId}`);
    return true;
  }

  const matchingCancellation = findCancellationToOwnConfirmation(state, job);
  if (matchingCancellation) {
    attachSupersededConfirmationJob(state, matchingCancellation, job);
    console.log(
      `[RPAQueue] Confirmation job superseded by pending cancellation: ${job.messageId} -> ${matchingCancellation.messageId}`,
    );
    return false;
  }

  const firstCancellationIndex = state.queue.findIndex(isCancellationJob);
  if (firstCancellationIndex === -1) {
    state.queue.push(job);
  } else {
    state.queue.splice(firstCancellationIndex, 0, job);
  }

  return true;
}

function getState() {
  const g = globalThis as RpaQueueGlobal;
  g.__memoroomRpaQueue ??= {
    queue: [],
    activeIds: new Set<string>(),
    failedUntil: new Map<string, number>(),
    failureCounts: new Map<string, number>(),
    manualCheckIds: new Set<string>(),
    retryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    retryJobs: new Map<string, RpaEmailJob>(),
    supersededConfirmationIds: new Set<string>(),
    running: false,
    slotRecheckRunning: false,
    lastSlotRecheckAt: 0,
    naverStatusReconcileRunning: false,
    lastNaverStatusReconcileAt: 0,
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
  state.retryJobs.delete(messageId);
}

function scheduleRetry(state: RpaQueueState, job: RpaEmailJob, retryDelay: number) {
  clearRetryTimer(state, job.messageId);

  const timer = setTimeout(() => {
    state.retryTimers.delete(job.messageId);
    state.failedUntil.delete(job.messageId);

    if (state.manualCheckIds.has(job.messageId) || state.activeIds.has(job.messageId)) return;

    const queued = pushJobByPriority(state, job);
    if (queued) state.activeIds.add(job.messageId);
    void drainRpaEmailQueue();
  }, retryDelay);

  state.retryTimers.set(job.messageId, timer);
  state.retryJobs.set(job.messageId, job);
}

export function isRpaEmailJobActive(messageId: string) {
  const state = getState();
  if (state.manualCheckIds.has(messageId)) return true;
  if (state.supersededConfirmationIds.has(messageId)) return true;
  if (state.retryTimers.has(messageId)) return true;
  const retryAt = state.failedUntil.get(messageId);
  if (retryAt && retryAt > Date.now()) return true;
  if (retryAt) state.failedUntil.delete(messageId);
  return state.activeIds.has(messageId);
}

export function enqueueRpaEmailJob(job: RpaEmailJob) {
  const state = getState();
  if (isRpaEmailJobActive(job.messageId)) return false;

  const queued = pushJobByPriority(state, job);
  if (queued) state.activeIds.add(job.messageId);
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
      state.currentJob = job;

      try {
        console.log(`[RPAQueue] Start ${job.source} job: ${job.messageId}`);
        let result: { reservationId?: string | null } | undefined;
        if (job.source === "naver") {
          result = await processNaverEmailWithRpa(job);
        } else {
          result = await processSpaceCloudEmailWithRpa(job);
        }
        await markEmailProcessed(job.messageId, job.source, result?.reservationId);
        for (const supersededJob of job.supersededConfirmationJobs ?? []) {
          await markEmailProcessed(supersededJob.messageId, supersededJob.source, result?.reservationId);
          state.supersededConfirmationIds.delete(supersededJob.messageId);
          console.log(
            `[RPAQueue] Marked superseded confirmation as processed after cancellation: ${supersededJob.messageId}`,
          );
        }
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
        state.currentJob = undefined;
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

export function enqueueNaverStatusReconcile() {
  const state = getState();
  const now = Date.now();
  const cooldownMs = 12 * 60 * 60 * 1000;
  if (state.naverStatusReconcileRunning) return false;
  if (now - state.lastNaverStatusReconcileAt < cooldownMs) return false;

  state.naverStatusReconcileRunning = true;
  state.lastNaverStatusReconcileAt = now;
  void (async () => {
    try {
      const result = await reconcileNaverReservationsWithoutCancelEmail(10);
      if (result.checked > 0 || result.cancelled > 0) {
        console.log(
          `[RPAQueue] Naver status reconcile done: checked ${result.checked}, cancelled ${result.cancelled}`,
        );
      }
    } catch (error) {
      console.error("[RPAQueue] Naver status reconcile failed:", error);
    } finally {
      state.naverStatusReconcileRunning = false;
    }
  })();

  return true;
}

export function getRpaQueueStatus() {
  const state = getState();
  return {
    queued: state.queue.length,
    activeOrCoolingDown:
      state.activeIds.size
      + state.failedUntil.size
      + state.manualCheckIds.size
      + state.retryTimers.size
      + state.supersededConfirmationIds.size,
    running: state.running,
    slotRecheckRunning: state.slotRecheckRunning,
    naverStatusReconcileRunning: state.naverStatusReconcileRunning,
  };
}
