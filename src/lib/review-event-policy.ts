export type ReviewProgress = {
  visitorReviewRequested: boolean;
  visitorReviewCompleted: boolean;
  visitorReviewRefunded: boolean;
  blogReviewRequested: boolean;
  blogReviewCompleted: boolean;
  blogReviewRefunded: boolean;
};

export function validateReviewProgress(progress: ReviewProgress) {
  if (
    (!progress.visitorReviewRequested && (progress.visitorReviewCompleted || progress.visitorReviewRefunded))
    || (progress.visitorReviewRefunded && !progress.visitorReviewCompleted)
    || (!progress.blogReviewRequested && (progress.blogReviewCompleted || progress.blogReviewRefunded))
    || (progress.blogReviewRefunded && !progress.blogReviewCompleted)
  ) {
    return "리뷰 신청 → 작성 → 환급 순서로 체크해 주세요.";
  }
  return null;
}

export function calculateReviewRefund(progress: Pick<ReviewProgress, "visitorReviewRefunded" | "blogReviewRefunded">) {
  return (progress.visitorReviewRefunded ? 3000 : 0) + (progress.blogReviewRefunded ? 5000 : 0);
}

export type ReviewProgressStage = "REQUESTED" | "COMPLETED" | "REFUNDED" | null;

export function getReviewProgressStage(progress: ReviewProgress): ReviewProgressStage {
  if (progress.visitorReviewRefunded || progress.blogReviewRefunded) return "REFUNDED";
  if (progress.visitorReviewCompleted || progress.blogReviewCompleted) return "COMPLETED";
  if (progress.visitorReviewRequested || progress.blogReviewRequested) return "REQUESTED";
  return null;
}
