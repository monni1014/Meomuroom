ALTER TABLE "Reservation"
ADD COLUMN "visitorReviewRequested" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Reservation"
ADD COLUMN "visitorReviewCompleted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Reservation"
ADD COLUMN "visitorReviewRefunded" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Reservation"
ADD COLUMN "blogReviewRequested" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Reservation"
ADD COLUMN "blogReviewCompleted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Reservation"
ADD COLUMN "blogReviewRefunded" BOOLEAN NOT NULL DEFAULT false;
