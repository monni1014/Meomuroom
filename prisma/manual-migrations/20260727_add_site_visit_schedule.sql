ALTER TABLE "CleaningSchedule"
ADD COLUMN "scheduleType" TEXT NOT NULL DEFAULT 'CLEANING';

ALTER TABLE "CleaningSchedule"
ADD COLUMN "contactPhone" TEXT;

ALTER TABLE "CleaningSchedule"
ADD COLUMN "source" TEXT;

CREATE INDEX IF NOT EXISTS "CleaningSchedule_scheduleType_startTime_idx"
  ON "CleaningSchedule"("scheduleType", "startTime");
