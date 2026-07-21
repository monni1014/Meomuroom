type ReservationTimeRange = {
  startTime: Date;
  endTime: Date;
};

export function resolveCancellationOperationalTimes(
  existing: ReservationTimeRange | null,
  incoming: ReservationTimeRange,
) {
  const source = existing || incoming;
  return {
    startTime: source.startTime,
    endTime: source.endTime,
  };
}
