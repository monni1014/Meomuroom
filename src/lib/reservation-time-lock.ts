export type ReservationTimeState = {
  startTime: Date;
  endTime: Date;
  syncedStartTime?: Date | null;
  syncedEndTime?: Date | null;
  timeLocked: boolean;
};

function sameTime(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function sameRange(
  leftStart: Date,
  leftEnd: Date,
  rightStart: Date,
  rightEnd: Date,
) {
  return sameTime(leftStart, rightStart) && sameTime(leftEnd, rightEnd);
}

export function resolveRpaReservationTimeState(
  existing: ReservationTimeState,
  syncedStartTime: Date,
  syncedEndTime: Date,
) {
  const hadSyncedBaseline = Boolean(existing.syncedStartTime && existing.syncedEndTime);
  const differsFromCalendar = !sameRange(
    existing.startTime,
    existing.endTime,
    syncedStartTime,
    syncedEndTime,
  );

  // Rows created before time locking have no synced baseline. If the first
  // RPA read differs from the calendar, keep the calendar range because it may
  // already contain an owner's manual correction or preparation time.
  const timeLocked = differsFromCalendar && (existing.timeLocked || !hadSyncedBaseline);

  return {
    startTime: timeLocked ? existing.startTime : syncedStartTime,
    endTime: timeLocked ? existing.endTime : syncedEndTime,
    syncedStartTime,
    syncedEndTime,
    timeLocked,
  };
}

export function shouldLockManuallyEditedTime(
  existing: ReservationTimeState,
  nextStartTime: Date,
  nextEndTime: Date,
) {
  const originalStartTime = existing.syncedStartTime || existing.startTime;
  const originalEndTime = existing.syncedEndTime || existing.endTime;

  return !sameRange(
    nextStartTime,
    nextEndTime,
    originalStartTime,
    originalEndTime,
  );
}
