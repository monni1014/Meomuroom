CREATE TABLE IF NOT EXISTS "CleaningSchedule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomName" TEXT NOT NULL DEFAULT '전체',
  "cleanerName" TEXT NOT NULL,
  "startTime" DATETIME NOT NULL,
  "endTime" DATETIME NOT NULL,
  "cost" INTEGER NOT NULL DEFAULT 0,
  "memo" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS "CleaningSchedule_startTime_idx"
  ON "CleaningSchedule"("startTime");

CREATE INDEX IF NOT EXISTS "CleaningSchedule_roomName_startTime_idx"
  ON "CleaningSchedule"("roomName", "startTime");
