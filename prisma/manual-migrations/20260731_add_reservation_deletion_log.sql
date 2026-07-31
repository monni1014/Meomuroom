CREATE TABLE IF NOT EXISTS "ReservationDeletionLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reservationId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "roomName" TEXT NOT NULL,
  "customerName" TEXT,
  "phone" TEXT,
  "startTime" DATETIME NOT NULL,
  "endTime" DATETIME NOT NULL,
  "reservationSnapshot" TEXT NOT NULL,
  "usageLogSnapshot" TEXT,
  "messageSnapshot" TEXT,
  "deletedFrom" TEXT,
  "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ReservationDeletionLog_reservationId_deletedAt_idx"
  ON "ReservationDeletionLog"("reservationId", "deletedAt");

CREATE INDEX IF NOT EXISTS "ReservationDeletionLog_deletedAt_idx"
  ON "ReservationDeletionLog"("deletedAt");
