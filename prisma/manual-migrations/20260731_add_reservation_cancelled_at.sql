ALTER TABLE "Reservation" ADD COLUMN "cancelledAt" DATETIME;

CREATE INDEX "Reservation_cancelledAt_idx"
ON "Reservation"("cancelledAt");

-- 기존 취소 건은 마지막 변경 시각을 최초 기준값으로 고정한다. 이후 메모나
-- RPA 점검으로 updatedAt이 바뀌어도 오늘 취소 목록에 다시 나타나지 않는다.
UPDATE "Reservation"
SET "cancelledAt" = "updatedAt"
WHERE "status" = 'CANCELLED'
  AND "cancelledAt" IS NULL;
