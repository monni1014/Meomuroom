"use client";

import { useEffect, useState } from "react";

const RPA_CHECK_MARKER = "RPA_CHECK_REQUIRED";
const RPA_PENDING_MARKER = "RPA_PENDING";
const PENDING_DELAY_MS = 60 * 1000;

function toTime(value?: string | Date | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function hasNaverSlotIssue(memo: string) {
  return /Naver slot .*failed|naver-toggle-slots|Unsupported Naver slot time|Could not find visual toggle|Unsafe save blocked/i.test(memo);
}

function hasSpaceCloudSlotIssue(memo: string) {
  return /SpaceCloud external reservation .*failed|spacecloud-external-reservation|Unsupported SpaceCloud external reservation time|SpaceCloud calendar|SpaceCloud product/i.test(memo);
}

function hasInfoReadIssue(memo: string) {
  return /missing customer|missing phone|phone number was not found|detail missing|detail read failed|could not read.*detail|could not find.*detail|refund fee was not verified|cancellation refund fee/i.test(memo);
}

function hasLoginIssue(memo: string) {
  return /login|로그인|session|세션|auth|authentication|unauthorized|forbidden|storage state|cookie|kakao|카카오|naver login|spacecloud login/i.test(memo);
}

function Badge({
  className,
  title,
  children,
}: {
  className: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border shadow-sm ${className}`} title={title}>
      {children}
    </span>
  );
}

export default function RpaStatusBadge({
  memo,
  createdAt,
  updatedAt,
}: {
  memo?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const hasPending = Boolean(memo?.includes(RPA_PENDING_MARKER));
  const hasCheck = Boolean(memo?.includes(RPA_CHECK_MARKER));

  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [hasPending]);

  if (!memo || (!hasPending && !hasCheck)) return null;

  const pendingStartedAt = toTime(createdAt) ?? toTime(updatedAt);
  const isPendingDelayed = hasPending && pendingStartedAt !== null && now - pendingStartedAt >= PENDING_DELAY_MS;

  if (hasCheck) {
    const naverSlotIssue = hasNaverSlotIssue(memo);
    const spaceCloudSlotIssue = hasSpaceCloudSlotIssue(memo);

    if ((naverSlotIssue || spaceCloudSlotIssue) && !hasLoginIssue(memo)) {
      return (
        <>
          {naverSlotIssue && (
            <Badge
              className="bg-red-50 text-red-700 border-red-300 shadow-red-100"
              title="네이버 예약 시간 슬롯 막기/열기 작업이 실패했습니다. 네이버 스마트플레이스 확인이 필요합니다."
            >
              네이버 슬롯 실패
            </Badge>
          )}
          {spaceCloudSlotIssue && (
            <Badge
              className="bg-violet-50 text-violet-700 border-violet-300 shadow-violet-100"
              title="스페이스클라우드 외부예약 추가/삭제 작업이 실패했습니다. 스클 캘린더 확인이 필요합니다."
            >
              스클 슬롯 실패
            </Badge>
          )}
        </>
      );
    }

    if (hasLoginIssue(memo)) {
      return (
        <Badge
          className="bg-red-100 text-red-800 border-red-400 shadow-red-100"
          title="네이버 또는 스페이스클라우드 로그인 세션 문제가 감지됐습니다. 로그인 상태를 다시 확인해 주세요."
        >
          로그인 확인필요
        </Badge>
      );
    }

    if (hasInfoReadIssue(memo)) {
      return (
        <Badge
          className="bg-red-50 text-red-700 border-red-300 shadow-red-100"
          title="이름, 전화번호, 환불수수료 같은 상세정보를 읽지 못했습니다. 직접 확인해 주세요."
        >
          정보 확인필요
        </Badge>
      );
    }

    return (
      <Badge
        className="bg-yellow-50 text-yellow-700 border-yellow-300 shadow-yellow-100"
        title="RPA가 예약을 처리하는 중 확실하지 않은 상황이 감지됐습니다. 직접 확인해 주세요."
      >
        RPA 확인필요
      </Badge>
    );
  }

  if (isPendingDelayed) {
    return (
      <Badge
        className="bg-red-50 text-red-700 border-red-300 shadow-red-100"
        title="메일은 감지됐지만 1분 넘게 상세정보 확인이 끝나지 않았습니다."
      >
        처리중 지연
      </Badge>
    );
  }

  return (
    <Badge
      className="bg-indigo-50 text-indigo-700 border-indigo-200 shadow-indigo-100"
      title="메일은 감지됐고, 상세정보와 슬롯 처리를 확인하는 중입니다."
    >
      처리중
    </Badge>
  );
}
