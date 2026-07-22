"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  CheckCheck,
  Clock3,
  MessageSquareText,
  Radio,
} from "lucide-react";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";
import { formatKoreanPhone } from "@/lib/phone-number";
import PushNotificationSetup from "@/components/PushNotificationSetup";

type DeliveryEntry = {
  reservationId: string;
  customerName: string | null;
  roomName: string;
  phone: string;
  startTime: string;
  endTime: string;
  scheduledAt: string;
  reservationStatus: string;
  status: string;
  error: string | null;
  sentAt: string | null;
  resultAt: string | null;
  providerMessageId: string | null;
  isTest: boolean;
};

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  SCHEDULED: { label: "발송 예정", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  SENDING: { label: "발송 준비 중", className: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  RECOVERING: { label: "솔라피 중복 확인 중", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  WAITING_CONTACT: { label: "전화번호 확인 중", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  WAITING_CONTACT_SYNC: { label: "연락처 동기화 중", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  SUBMITTED: { label: "솔라피 접수", className: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  CARRIER_ACCEPTED: { label: "통신사 처리 중", className: "bg-violet-50 text-violet-700 ring-violet-200" },
  DELIVERED: { label: "수신 완료", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  FAILED: { label: "발송 실패", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  MISSING_PHONE: { label: "전화번호 누락", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  OVERDUE: { label: "발송시간 지남", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  DRY_RUN: { label: "테스트 · 미발송", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  CANCELLED: { label: "예약 취소", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  PENDING: { label: "발송 예정", className: "bg-sky-50 text-sky-700 ring-sky-200" },
};

const ATTENTION_STATUSES = new Set(["FAILED", "MISSING_PHONE", "OVERDUE", "DRY_RUN"]);
const PROCESSING_STATUSES = new Set(["SENDING", "RECOVERING", "SUBMITTED", "CARRIER_ACCEPTED"]);
const SCHEDULED_STATUSES = new Set(["SCHEDULED", "PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"]);

function formatKst(value: string, includeDate = true) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    ...(includeDate ? { month: "numeric", day: "numeric", weekday: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function statusStyle(status: string) {
  return STATUS_STYLE[status] || { label: status, className: "bg-slate-100 text-slate-600 ring-slate-200" };
}

function needsAttention(entry: DeliveryEntry) {
  return ATTENTION_STATUSES.has(entry.status);
}

function sortWeight(entry: DeliveryEntry) {
  if (needsAttention(entry)) return 0;
  if (PROCESSING_STATUSES.has(entry.status)) return 1;
  if (SCHEDULED_STATUSES.has(entry.status)) return 2;
  if (entry.status === "DELIVERED") return 3;
  return 4;
}

export default function MessagesView({
  initialEntries,
  todayLabel,
}: {
  initialEntries: DeliveryEntry[];
  todayLabel: string;
}) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  useDataChangePolling("/api/data-version?scope=messages", refresh, { intervalMs: 5_000 });

  const stats = useMemo(() => ({
    scheduled: initialEntries.filter((entry) => SCHEDULED_STATUSES.has(entry.status)).length,
    processing: initialEntries.filter((entry) => PROCESSING_STATUSES.has(entry.status)).length,
    delivered: initialEntries.filter((entry) => entry.status === "DELIVERED").length,
    attention: initialEntries.filter(needsAttention).length,
  }), [initialEntries]);

  const sortedEntries = useMemo(() => [...initialEntries]
    .sort((left, right) => {
      const weight = sortWeight(left) - sortWeight(right);
      if (weight !== 0) return weight;
      if (left.status === "DELIVERED" && right.status === "DELIVERED") {
        return new Date(right.resultAt || right.sentAt || right.startTime).getTime()
          - new Date(left.resultAt || left.sentAt || left.startTime).getTime();
      }
      return new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime();
    }), [initialEntries]);

  function processingLabel(entry: DeliveryEntry) {
    const value = entry.resultAt || entry.sentAt;
    if (entry.status === "DELIVERED") return value ? `수신 완료 ${formatKst(value)}` : "수신 완료";
    if (needsAttention(entry)) return value ? `확인 필요 ${formatKst(value)}` : "확인 필요";
    if (entry.status === "CARRIER_ACCEPTED") return value ? `통신사 처리 중 ${formatKst(value)}` : "통신사 처리 중";
    if (entry.status === "SUBMITTED") return value ? `솔라피 접수 ${formatKst(value)}` : "솔라피 접수";
    if (entry.status === "RECOVERING") return "솔라피 발송 이력 확인 중";
    if (entry.status === "SENDING") return "발송 작업 중";
    return `발송 예정 ${formatKst(entry.scheduledAt)}`;
  }

  return (
    <div className="min-h-full bg-slate-50 px-4 pb-24 pt-16 sm:px-6 md:pb-8 md:pt-20 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-center gap-3">
          <div className="rounded-2xl bg-indigo-600 p-3 text-white shadow-sm">
            <MessageSquareText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">오늘 문자 현황</h1>
            <p className="mt-1 text-sm text-slate-500">
              {todayLabel} 발송 대상 {initialEntries.length}건 · 고객 휴대폰의 수신 완료만 성공으로 집계합니다.
            </p>
          </div>
        </header>

        <PushNotificationSetup />

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "발송 예정", value: stats.scheduled, icon: CalendarClock, tone: "text-sky-600 bg-sky-50" },
            { label: "처리 중 · 미완료", value: stats.processing, icon: Radio, tone: "text-indigo-600 bg-indigo-50" },
            { label: "수신 완료", value: stats.delivered, icon: CheckCheck, tone: "text-emerald-600 bg-emerald-50" },
            { label: "실패 · 확인 필요", value: stats.attention, icon: AlertTriangle, tone: "text-rose-600 bg-rose-50" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className={`inline-flex rounded-xl p-2 ${stat.tone}`}><stat.icon className="h-5 w-5" /></div>
              <p className="mt-3 text-xs font-bold text-slate-500">{stat.label}</p>
              <p className="mt-1 text-2xl font-black text-slate-900">{stat.value}건</p>
            </div>
          ))}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5">
            <h2 className="font-black text-slate-900">{todayLabel} 발송 대상</h2>
            <p className="mt-1 text-xs text-slate-500">확인이 필요한 문자부터 위에 표시합니다.</p>
          </div>

          <div className="divide-y divide-slate-100">
            {sortedEntries.map((entry) => {
              const style = statusStyle(entry.status);
              return (
                <article key={entry.reservationId} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-black text-slate-900">{entry.customerName || "이름 없음"}</p>
                        <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">{entry.roomName}</span>
                        {entry.isTest && (
                          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-extrabold text-amber-800 ring-1 ring-inset ring-amber-200">
                            강제 테스트
                          </span>
                        )}
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ring-inset ${style.className}`}>{style.label}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-700">
                        {formatKst(entry.startTime)} - {formatKst(entry.endTime, false)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {entry.phone ? formatKoreanPhone(entry.phone) : "전화번호 없음"}
                        <span className="mx-1.5">·</span>
                        발송예정 {formatKst(entry.scheduledAt)}
                      </p>
                      {entry.error && (
                        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{entry.error}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                      <Clock3 className="h-4 w-4" />
                      {processingLabel(entry)}
                    </div>
                  </div>
                </article>
              );
            })}
            {sortedEntries.length === 0 && (
              <div className="p-12 text-center text-sm text-slate-400">오늘 발송 대상인 예약이 없습니다.</div>
            )}
          </div>
        </section>

        <p className="px-1 text-xs leading-5 text-slate-500">
          ‘솔라피 접수’와 ‘통신사 처리 중’은 아직 성공이 아닙니다. 고객 휴대폰의 ‘수신 완료’ 결과만 최종 성공이며, 결과는 5초마다 자동 갱신됩니다.
        </p>
      </div>
    </div>
  );
}
