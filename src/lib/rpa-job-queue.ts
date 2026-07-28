import type { ParsedReservation } from "./email-parser";
import {
  processNaverEmailWithRpa,
  reconcileNaverReservationsWithoutCancelEmail,
  recheckNaverSlotRpaIssues,
} from "./naver-rpa-sync";
import { markEmailProcessed } from "./processed-email";
import { markRpaJobCheckRequired } from "./rpa-reservation-state";
import { processSpaceCloudEmailWithRpa } from "./spacecloud-rpa-sync";
import { sendSpaceCloudBookingPush } from "./spacecloud-booking-push";
import {
  getRpaProxyCircuitState,
  isRpaPausedForProxy,
} from "./rpa-proxy-circuit";
import {
  CANCELLATION_MAX_QUEUE_WAIT_MS,
  MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION,
  cancellationQueueWaitMs,
  isCancellationPriorityJob,
  selectNextRpaJobIndex,
} from "./rpa-job-priority";

export type RpaEmailJob = {
  messageId: string;
  source: "naver" | "spacecloud";
  subject: string;
  text: string;
  html?: string | false;
  parsedReservation: ParsedReservation;
  receivedAt?: Date;
  supersededConfirmationJobs?: RpaEmailJob[];
  enqueuedAt?: number;
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
  runningSources: Set<RpaEmailJob["source"]>;
  currentJobs: Partial<Record<RpaEmailJob["source"], RpaEmailJob>>;
  slotRecheckRunning: boolean;
  slotRecheckPending: boolean;
  lastSlotRecheckAt: number;
  naverStatusReconcileRunning: boolean;
  naverStatusReconcilePending: boolean;
  lastNaverStatusReconcileAt: number;
  proxyPauseLogged: boolean;
  confirmationRunsWhileCancellationWaiting: Record<RpaEmailJob["source"], number>;
};

type RpaQueueGlobal = typeof globalThis & {
  __memoroomRpaQueue?: RpaQueueState;
};

const FAILED_RETRY_COOLDOWNS_MS = [60 * 1000, 2 * 60 * 1000] as const;
const MAX_AUTO_FAILURES = 3;
const SLOT_RECHECK_COOLDOWN_MS = 10 * 60 * 1000;

function isCancellationJob(job: RpaEmailJob) {
  return isCancellationPriorityJob(job);
}

function triggerPostRpaReservationCommunication(job: RpaEmailJob, reservationId?: string | null) {
  if (!reservationId || isCancellationJob(job)) return;

  void import("./reservation-notifications")
    .then(async ({ sendDueReservationReminders }) => {
      const { sendDueDawnBookingConfirmations } = await import("./dawn-booking-notifications");
      const { sendDueOnTimeExitMessages } = await import("./on-time-exit-notifications");
      const dawnResult = await sendDueDawnBookingConfirmations();
      const result = await sendDueReservationReminders();
      const exitResult = await sendDueOnTimeExitMessages();
      return { result, dawnResult, exitResult };
    })
    .then(({ result, dawnResult, exitResult }) => {
      console.log(
        `[RPAQueue] Post-RPA contact sync/notification: reservation=${reservationId}, guide-checked=${result.checkedCount}, guide-sent=${result.sentCount}, dawn-checked=${dawnResult.checkedCount}, dawn-sent=${dawnResult.sentCount}, exit-checked=${exitResult.checkedCount}, exit-sent=${exitResult.sentCount}, waiting-contact=${result.waitingContactCount + dawnResult.waitingContactCount}, waiting-contact-sync=${result.waitingContactSyncCount}, google-sync=${result.contactSyncMs}ms, pipeline=${result.pipelineMs + dawnResult.pipelineMs + exitResult.pipelineMs}ms`,
      );
    })
    .catch((error) => {
      console.error(
        `[RPAQueue] Post-RPA contact sync/notification failed: reservation=${reservationId}`,
        error instanceof Error ? error.message : String(error),
      );
    });
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

  const currentJob = state.currentJobs[confirmationJob.source];
  if (
    currentJob
    && isCancellationJob(currentJob)
    && isSameQueuedReservation(currentJob, confirmationJob)
  ) {
    return currentJob;
  }

  return state.queue.find((queuedJob) =>
    isCancellationJob(queuedJob) && isSameQueuedReservation(queuedJob, confirmationJob)
  ) || null;
}

function pushJobByPriority(state: RpaQueueState, job: RpaEmailJob) {
  if (isCancellationJob(job)) {
    removeQueuedConfirmationForCancellation(state, job);
    state.queue.push(job);
    console.log(
      `[RPAQueue] Queued cancellation behind confirmations (max wait ${CANCELLATION_MAX_QUEUE_WAIT_MS / 1000}s): ${job.messageId}`,
    );
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
    runningSources: new Set<RpaEmailJob["source"]>(),
    currentJobs: {},
    slotRecheckRunning: false,
    slotRecheckPending: false,
    lastSlotRecheckAt: 0,
    naverStatusReconcileRunning: false,
    naverStatusReconcilePending: false,
    lastNaverStatusReconcileAt: 0,
    proxyPauseLogged: false,
    confirmationRunsWhileCancellationWaiting: { naver: 0, spacecloud: 0 },
  };
  const state = g.__memoroomRpaQueue;
  state.runningSources ??= new Set<RpaEmailJob["source"]>();
  state.currentJobs ??= {};
  state.slotRecheckPending ??= false;
  state.naverStatusReconcilePending ??= false;
  state.proxyPauseLogged ??= false;
  state.confirmationRunsWhileCancellationWaiting ??= { naver: 0, spacecloud: 0 };
  return state;
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
    void drainRpaEmailQueue(job.source);
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
  return enqueueRpaEmailJobs([job]) > 0;
}

export function enqueueRpaEmailJobs(jobs: RpaEmailJob[]) {
  const state = getState();
  let accepted = 0;
  const acceptedSources = new Set<RpaEmailJob["source"]>();

  for (const job of jobs) {
    if (isRpaEmailJobActive(job.messageId)) continue;

    job.enqueuedAt ??= Date.now();

    const queued = pushJobByPriority(state, job);
    if (queued) state.activeIds.add(job.messageId);
    if (queued || state.supersededConfirmationIds.has(job.messageId)) accepted += 1;
    if (queued) acceptedSources.add(job.source);
  }

  for (const source of acceptedSources) void drainRpaEmailQueue(source);
  return accepted;
}

async function drainRpaEmailQueue(source: RpaEmailJob["source"]) {
  const state = getState();
  if (state.runningSources.has(source)) return;

  state.runningSources.add(source);
  try {
    while (true) {
      if (isRpaPausedForProxy()) {
        if (!state.proxyPauseLogged) {
          const circuit = getRpaProxyCircuitState();
          console.warn(
            `[RPAQueue] Proxy circuit ${circuit.mode}. Keep queued RPA jobs waiting: ${circuit.reason}`,
          );
          state.proxyPauseLogged = true;
        }
        break;
      }
      state.proxyPauseLogged = false;

      const now = Date.now();
      const firstSourceJobIndex = state.queue.findIndex((queuedJob) => queuedJob.source === source);
      const confirmationRunCount = state.confirmationRunsWhileCancellationWaiting[source];
      const jobIndex = selectNextRpaJobIndex(
        state.queue,
        source,
        now,
        CANCELLATION_MAX_QUEUE_WAIT_MS,
        confirmationRunCount,
      );
      if (jobIndex === -1) break;
      const [job] = state.queue.splice(jobIndex, 1);
      if (!job) continue;

      if (jobIndex !== firstSourceJobIndex && isCancellationJob(job)) {
        console.log(
          `[RPAQueue] Cancellation fairness threshold reached (wait ${Math.round(cancellationQueueWaitMs(job, now) / 1000)}s, confirmations ${confirmationRunCount}/${MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION}). Run before later confirmations: ${job.messageId}`,
        );
      }
      state.currentJobs[source] = job;
      let deferredForProxy = false;

      try {
        console.log(`[RPAQueue] Start ${job.source} job: ${job.messageId}`);
        let result: { reservationId?: string | null } | undefined;
        if (job.source === "naver") {
          result = await processNaverEmailWithRpa(job);
        } else {
          result = await processSpaceCloudEmailWithRpa(job);
        }
        if (job.source === "spacecloud" && !isCancellationJob(job) && result?.reservationId) {
          const push = await sendSpaceCloudBookingPush(result.reservationId);
          console.log(
            `[RPAQueue] SpaceCloud booking push: reservation=${result.reservationId}, skipped=${push.skipped}, sent=${push.sent}, failed=${push.failed}, reason=${push.reason || "-"}, apple-excluded=true`,
          );
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
        triggerPostRpaReservationCommunication(job, result?.reservationId);
        console.log(`[RPAQueue] Done ${job.source} job: ${job.messageId}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (isRpaPausedForProxy() || reason.includes("[RPA_PROXY_PAUSED]")) {
          pushJobByPriority(state, job);
          deferredForProxy = true;
          console.warn(
            `[RPAQueue] Proxy became unavailable. Returned job to waiting queue without counting a failure: ${job.messageId}`,
          );
          continue;
        }

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
        if (!deferredForProxy) state.activeIds.delete(job.messageId);
        delete state.currentJobs[source];

        if (isCancellationJob(job)) {
          state.confirmationRunsWhileCancellationWaiting[source] = 0;
        } else if (state.queue.some((queuedJob) => queuedJob.source === source && isCancellationJob(queuedJob))) {
          state.confirmationRunsWhileCancellationWaiting[source] += 1;
        } else {
          state.confirmationRunsWhileCancellationWaiting[source] = 0;
        }
      }
    }
  } finally {
    state.runningSources.delete(source);
  }
}

function startSlotRecheck(state: RpaQueueState) {
  if (state.slotRecheckRunning) return false;
  if (isRpaPausedForProxy()) {
    state.slotRecheckPending = true;
    return true;
  }

  state.slotRecheckPending = false;
  state.slotRecheckRunning = true;
  state.lastSlotRecheckAt = Date.now();
  void (async () => {
    try {
      const result = await recheckNaverSlotRpaIssues(1);
      if (result.checked > 0) {
        console.log(`[RPAQueue] Slot recheck done: checked ${result.checked}, resolved ${result.resolved}`);
      }
    } catch (error) {
      if (isRpaPausedForProxy()) state.slotRecheckPending = true;
      console.error("[RPAQueue] Slot recheck failed:", error);
    } finally {
      state.slotRecheckRunning = false;
    }
  })();
  return true;
}

export function enqueueRpaSlotRecheck() {
  const state = getState();
  const now = Date.now();
  if (state.slotRecheckRunning || state.slotRecheckPending) return false;
  if (now - state.lastSlotRecheckAt < SLOT_RECHECK_COOLDOWN_MS) return false;
  return startSlotRecheck(state);
}

function startNaverStatusReconcile(state: RpaQueueState) {
  if (state.naverStatusReconcileRunning) return false;
  if (isRpaPausedForProxy()) {
    state.naverStatusReconcilePending = true;
    return true;
  }

  state.naverStatusReconcilePending = false;
  state.naverStatusReconcileRunning = true;
  state.lastNaverStatusReconcileAt = Date.now();
  void (async () => {
    try {
      const result = await reconcileNaverReservationsWithoutCancelEmail(10);
      if (result.checked > 0 || result.cancelled > 0) {
        console.log(
          `[RPAQueue] Naver status reconcile done: checked ${result.checked}, cancelled ${result.cancelled}`,
        );
      }
    } catch (error) {
      if (isRpaPausedForProxy()) state.naverStatusReconcilePending = true;
      console.error("[RPAQueue] Naver status reconcile failed:", error);
    } finally {
      state.naverStatusReconcileRunning = false;
    }
  })();
  return true;
}

export function enqueueNaverStatusReconcile() {
  const state = getState();
  const now = Date.now();
  const cooldownMs = 12 * 60 * 60 * 1000;
  if (state.naverStatusReconcileRunning || state.naverStatusReconcilePending) return false;
  if (now - state.lastNaverStatusReconcileAt < cooldownMs) return false;
  return startNaverStatusReconcile(state);
}

export function resumeRpaWorkAfterProxyRecovery() {
  const state = getState();
  if (isRpaPausedForProxy()) return false;

  state.proxyPauseLogged = false;
  const queuedSources = new Set(state.queue.map((job) => job.source));
  for (const source of queuedSources) void drainRpaEmailQueue(source);
  if (state.slotRecheckPending) startSlotRecheck(state);
  if (state.naverStatusReconcilePending) startNaverStatusReconcile(state);
  return true;
}

export function getRpaQueueStatus() {
  const state = getState();
  const now = Date.now();
  const oldestCancellationWaitMs = state.queue.reduce((oldest, job) => (
    isCancellationJob(job)
      ? Math.max(oldest, cancellationQueueWaitMs(job, now))
      : oldest
  ), 0);

  return {
    queued: state.queue.length,
    active: state.activeIds.size,
    retryPending: state.retryTimers.size,
    manualCheckPending: state.manualCheckIds.size,
    activeOrCoolingDown:
      state.activeIds.size
      + state.failedUntil.size
      + state.manualCheckIds.size
      + state.retryTimers.size
      + state.supersededConfirmationIds.size,
    running: state.runningSources.size > 0,
    runningBySource: {
      naver: state.runningSources.has("naver"),
      spacecloud: state.runningSources.has("spacecloud"),
    },
    slotRecheckRunning: state.slotRecheckRunning,
    slotRecheckPending: state.slotRecheckPending,
    naverStatusReconcileRunning: state.naverStatusReconcileRunning,
    naverStatusReconcilePending: state.naverStatusReconcilePending,
    proxyCircuit: getRpaProxyCircuitState(),
    oldestCancellationWaitMs,
    cancellationMaxWaitMs: CANCELLATION_MAX_QUEUE_WAIT_MS,
    maxConfirmationRunsBeforeCancellation: MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION,
    confirmationRunsWhileCancellationWaiting: { ...state.confirmationRunsWhileCancellationWaiting },
  };
}
