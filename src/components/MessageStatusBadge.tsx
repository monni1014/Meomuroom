"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";

type MessageStatusBadgeProps = {
  notified?: boolean | null;
  notifiedAt?: string | Date | null;
  notificationStatus?: string | null;
  notificationChannel?: string | null;
  notificationError?: string | null;
  startTime?: string | Date | null;
  status?: string | null;
  phone?: string | null;
};

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const STALE_AFTER_START_MS = 30 * 60 * 1000;

function toTime(value?: string | Date | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function formatKst(value?: string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function MessageStatusBadge({
  notified,
  notifiedAt,
  notificationStatus,
  notificationChannel,
  notificationError,
  startTime,
  status,
  phone,
}: MessageStatusBadgeProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (status === "CANCELLED") return null;

  const normalizedStatus = notificationStatus || (notified ? "SENT" : "PENDING");
  const start = toTime(startTime);
  const sendWindowOpened = now !== null && start !== null && start - now <= TWO_HOURS_MS;
  const sendWindowExpired = now !== null && start !== null && now - start > STALE_AFTER_START_MS;
  const missingPhone = !phone?.replace(/\D/g, "");

  if (normalizedStatus === "DELIVERED") {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-600 shadow-sm"
        title={`예약 안내 수신완료${notificationChannel ? ` (${notificationChannel})` : ""}${notifiedAt ? ` - ${formatKst(notifiedAt)}` : ""}`}
      >
        <MessageCircle className="h-3 w-3" />
        <span className="sr-only">문자 수신완료</span>
      </span>
    );
  }

  if (normalizedStatus === "FAILED" || (sendWindowExpired && !notified) || (sendWindowOpened && missingPhone)) {
    const reason = notificationError || (missingPhone ? "예약자 전화번호가 없습니다." : "발송완료 기록이 없습니다.");
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-rose-600 shadow-sm shadow-rose-100"
        title={`예약 안내 발송 실패: ${reason}`}
      >
        <MessageCircle className="h-3 w-3" />
        <span className="sr-only">문자 발송실패</span>
      </span>
    );
  }

  if (normalizedStatus === "DRY_RUN") {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-600 shadow-sm"
        title="문자 테스트 모드입니다. 실제 발송은 하지 않았습니다."
      >
        <MessageCircle className="h-3 w-3" />
        <span className="sr-only">문자 테스트모드</span>
      </span>
    );
  }

  if (["SENT", "SENDING", "SUBMITTED", "CARRIER_ACCEPTED"].includes(normalizedStatus)) {
    const label = normalizedStatus === "CARRIER_ACCEPTED" ? "통신사 처리 중" : "문자 수신 결과 확인 중";
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-600 shadow-sm"
        title={`${label}${notifiedAt ? ` - ${formatKst(notifiedAt)}` : ""}`}
      >
        <MessageCircle className="h-3 w-3" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-400 shadow-sm"
      title={sendWindowOpened ? "예약 안내 발송 대기 중입니다." : "예약 2시간 전에 안내 문자를 발송합니다."}
    >
      <MessageCircle className="h-3 w-3" />
      <span className="sr-only">문자 발송대기</span>
    </span>
  );
}
