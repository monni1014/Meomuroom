export const CANCELLATION_MAX_QUEUE_WAIT_MS = 3 * 60 * 1000;

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
) {
  const firstSourceIndex = queue.findIndex((job) => job.source === source);
  if (firstSourceIndex === -1) return -1;

  const overdueCancellationIndex = queue.findIndex((job) => (
    job.source === source
    && isCancellationPriorityJob(job)
    && cancellationQueueWaitMs(job, now) >= cancellationMaxWaitMs
  ));

  return overdueCancellationIndex === -1 ? firstSourceIndex : overdueCancellationIndex;
}
