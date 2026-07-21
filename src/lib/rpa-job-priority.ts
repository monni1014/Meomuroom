export const CANCELLATION_MAX_QUEUE_WAIT_MS = 3 * 60 * 1000;
export const MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION = 2;

export type RpaPriorityJob = {
  source: "naver" | "spacecloud";
  parsedReservation: { isCancelled?: boolean };
  enqueuedAt?: number;
};

export function isCancellationPriorityJob(job: RpaPriorityJob) {
  return Boolean(job.parsedReservation.isCancelled);
}

export function cancellationQueueWaitMs(job: RpaPriorityJob, now = Date.now()) {
  if (!isCancellationPriorityJob(job) || job.enqueuedAt === undefined) return 0;
  return Math.max(0, now - job.enqueuedAt);
}

export function selectNextRpaJobIndex<T extends RpaPriorityJob>(
  queue: T[],
  source: T["source"],
  now = Date.now(),
  cancellationMaxWaitMs = CANCELLATION_MAX_QUEUE_WAIT_MS,
  confirmationRunsWhileCancellationWaiting = 0,
  maxConfirmationRuns = MAX_CONFIRMATION_RUNS_BEFORE_CANCELLATION,
) {
  const firstSourceIndex = queue.findIndex((job) => job.source === source);
  if (firstSourceIndex === -1) return -1;

  const firstCancellationIndex = queue.findIndex((job) => (
    job.source === source
    && isCancellationPriorityJob(job)
  ));
  if (firstCancellationIndex === -1) return firstSourceIndex;

  const cancellationIsOverdue = cancellationQueueWaitMs(queue[firstCancellationIndex], now) >= cancellationMaxWaitMs;
  const confirmationRunLimitReached = confirmationRunsWhileCancellationWaiting >= maxConfirmationRuns;

  return cancellationIsOverdue || confirmationRunLimitReached
    ? firstCancellationIndex
    : firstSourceIndex;
}
