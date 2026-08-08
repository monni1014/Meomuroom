import { parseNaverReviewRequests } from "../src/lib/email-parser.ts";
import { calculateReviewRefund, getReviewProgressStage, getReviewRefundAccountMessageDecision, hasNewlyCompletedReview, validateReviewProgress } from "../src/lib/review-event-policy.ts";

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

const bothRequested = parseNaverReviewRequests(
  "결제금액 머무룸 예약하기 3(4) 28,800원 + 방문자리뷰 3천원 환급(1)0원 + 블로그리뷰 5천원 환급(1)0원 = 27,800원",
);
assertEqual("visitor request", bothRequested.visitorReviewRequested, true);
assertEqual("blog request", bothRequested.blogReviewRequested, true);

const visitorOnly = parseNaverReviewRequests(
  "방문자 리뷰 3천원 환급 ( 1 ) 0원 + 블로그 리뷰 5천원 환급(0)0원",
);
assertEqual("visitor-only request", visitorOnly.visitorReviewRequested, true);
assertEqual("visitor-only excludes blog", visitorOnly.blogReviewRequested, false);

const quantityStillMeansOneRequest = parseNaverReviewRequests(
  "방문자리뷰 3천원 환급(4)0원 + 블로그리뷰 5천원 환급(5)0원",
);
assertEqual("visitor quantity 4 means one request", quantityStillMeansOneRequest.visitorReviewRequested, true);
assertEqual("blog quantity 5 means one request", quantityStillMeansOneRequest.blogReviewRequested, true);

const zeroQuantityMeansNoRequest = parseNaverReviewRequests(
  "방문자리뷰 3천원 환급(0)0원 + 블로그리뷰 5천원 환급(0)0원",
);
assertEqual("visitor quantity 0 means no request", zeroQuantityMeansNoRequest.visitorReviewRequested, false);
assertEqual("blog quantity 0 means no request", zeroQuantityMeansNoRequest.blogReviewRequested, false);

assertEqual(
  "refund before completion is rejected",
  validateReviewProgress({
    visitorReviewRequested: true,
    visitorReviewCompleted: false,
    visitorReviewRefunded: true,
    blogReviewRequested: false,
    blogReviewCompleted: false,
    blogReviewRefunded: false,
  }),
  "리뷰 신청 → 작성 → 환급 순서로 체크해 주세요.",
);

assertEqual(
  "valid completed review",
  validateReviewProgress({
    visitorReviewRequested: true,
    visitorReviewCompleted: true,
    visitorReviewRefunded: true,
    blogReviewRequested: true,
    blogReviewCompleted: true,
    blogReviewRefunded: true,
  }),
  null,
);
assertEqual(
  "combined refund",
  calculateReviewRefund({ visitorReviewRefunded: true, blogReviewRefunded: true }),
  8000,
);

const reviewProgress = {
  visitorReviewRequested: false,
  visitorReviewCompleted: false,
  visitorReviewRefunded: false,
  blogReviewRequested: false,
  blogReviewCompleted: false,
  blogReviewRefunded: false,
};
assertEqual("no review badge", getReviewProgressStage(reviewProgress), null);
assertEqual(
  "requested review badge",
  getReviewProgressStage({ ...reviewProgress, visitorReviewRequested: true }),
  "REQUESTED",
);
assertEqual(
  "completed review badge",
  getReviewProgressStage({
    ...reviewProgress,
    visitorReviewRequested: true,
    visitorReviewCompleted: true,
  }),
  "COMPLETED",
);
assertEqual(
  "refunded review badge",
  getReviewProgressStage({
    ...reviewProgress,
    visitorReviewRequested: true,
    visitorReviewCompleted: true,
    visitorReviewRefunded: true,
  }),
  "REFUNDED",
);

assertEqual(
  "first completed review triggers account request",
  hasNewlyCompletedReview(
    { visitorReviewCompleted: false, blogReviewCompleted: false },
    { visitorReviewCompleted: true, blogReviewCompleted: false },
  ),
  true,
);
assertEqual(
  "unchanged completed review does not trigger",
  hasNewlyCompletedReview(
    { visitorReviewCompleted: true, blogReviewCompleted: false },
    { visitorReviewCompleted: true, blogReviewCompleted: false },
  ),
  false,
);
assertEqual(
  "later second review completion does not trigger another account request",
  hasNewlyCompletedReview(
    { visitorReviewCompleted: true, blogReviewCompleted: false },
    { visitorReviewCompleted: true, blogReviewCompleted: true },
  ),
  false,
);

const noCompletedReview = { visitorReviewCompleted: false, blogReviewCompleted: false };
const visitorReviewCompleted = { visitorReviewCompleted: true, blogReviewCompleted: false };
assertEqual(
  "first completion requires a message choice",
  getReviewRefundAccountMessageDecision(noCompletedReview, visitorReviewCompleted, undefined),
  "ACTION_REQUIRED",
);
assertEqual(
  "first completion can send account request",
  getReviewRefundAccountMessageDecision(noCompletedReview, visitorReviewCompleted, "SEND"),
  "SEND",
);
assertEqual(
  "first completion can skip account request",
  getReviewRefundAccountMessageDecision(noCompletedReview, visitorReviewCompleted, "SKIP"),
  "SKIP",
);
assertEqual(
  "later second completion never sends another account request",
  getReviewRefundAccountMessageDecision(
    visitorReviewCompleted,
    { visitorReviewCompleted: true, blogReviewCompleted: true },
    "SEND",
  ),
  "NONE",
);

console.log("Review event tracking tests passed.");
