const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

export type StoredGooglePeopleDailyStats = {
  dailyDate?: string;
  dailyDeletedCount?: number;
  dailyRestoredCount?: number;
};

export type GooglePeopleDailyStats = {
  date: string;
  deletedCount: number;
  restoredCount: number;
};

export function seoulDateKey(date: Date) {
  return new Date(date.getTime() + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
}

export function getGooglePeopleDailyStats(
  stored: StoredGooglePeopleDailyStats,
  now = new Date(),
): GooglePeopleDailyStats {
  const date = seoulDateKey(now);
  if (stored.dailyDate !== date) {
    return { date, deletedCount: 0, restoredCount: 0 };
  }
  return {
    date,
    deletedCount: stored.dailyDeletedCount || 0,
    restoredCount: stored.dailyRestoredCount || 0,
  };
}

export function accumulateGooglePeopleDailyStats(
  stored: StoredGooglePeopleDailyStats,
  current: { deletedCount: number; restoredCount: number },
  now = new Date(),
): GooglePeopleDailyStats {
  const previous = getGooglePeopleDailyStats(stored, now);
  return {
    date: previous.date,
    deletedCount: previous.deletedCount + current.deletedCount,
    restoredCount: previous.restoredCount + current.restoredCount,
  };
}
