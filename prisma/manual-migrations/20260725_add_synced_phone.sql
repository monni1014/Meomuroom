ALTER TABLE "Reservation"
ADD COLUMN "syncedPhone" TEXT;

UPDATE "Reservation"
SET "syncedPhone" = "phone"
WHERE "source" IN ('naver', 'spacecloud')
  AND "phoneLocked" = 0;
