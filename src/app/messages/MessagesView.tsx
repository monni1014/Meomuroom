"use client";

import { useCallback, useMemo, useState } from "react";
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
  providerMessageId: string | null;
};

type Filter = "ALL" | "ATTENTION" | "PROCESSING" | "SCHEDULED" | "DELIVERED";

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  SCHEDULED: { label: "발송 예정", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  SENDING: { label: "발송 준비 중", className: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  WAITING_CONTACT: { label: "전화번호 확인 중", className: "bg-amber-50 text-amber-800 ring-amber-200" },
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

const ATTENTION_STATUSES = new Set(["FAILED", "MISSING_PHONE", "OVERDUE"]);
const PROCESSING_STATUSES = new Set(["SUBMITTED", "CARRIER_ACCEPTED"]);
const SCHEDULED_STATUSES = new Set(["SCHEDULED", "PENDING", "WAITING_CONTACT"]);

function formatKst(value: string, includeDate = true) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    ...(includeDate ? { month: "numeric", day: "numeric", weekday: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function kstDateKey(value: Date | string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function statusStyle(status: string) {
  return STATUS_STYLE[status] || { label: status, className: "bg-slate-100 text-slate-600 ring-slate-200" };
}

function needsAttention(entry: DeliveryEntry) {
  if (ATTENTION_STATUSES.has(entry.status)) return true;
  return entry.status === "DRY_RUN" && new Date(entry.endTime).getTime() >= Date.now();
}

function matchesFilter(entry: DeliveryEntry, filter: Filter) {
  if (filter === "ALL") return entry.status !== "CANCELLED";
  if (filter === "ATTENTION") return needsAttention(entry);
  if (filter === "PROCESSING") return PROCESSING_STATUSES.has(entry.status);
  if (filter === "SCHEDULED") return SCHEDULED_STATUSES.has(entry.status);
  return entry.status === "DELIVERED";
}

function sortWeight(entry: DeliveryEntry) {
  if (needsAttention(entry)) return 0;
  if (PROCESSING_STATUSES.has(entry.status)) return 1;
  if (SCHEDULED_STATUSES.has(entry.status)) return 2;
  if (entry.status === "DELIVERED") return 3;
  return 4;
}

export default function MessagesView({ initialEntries }: { initialEntries: DeliveryEntry[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("ALL");
  const refresh = useCallback(() => router.refresh(), [router]);
  useDataChangePolling("/api/data-version?scope=messages", refresh, { intervalMs: 5_000 });

  const todayKey = kstDateKey(new Date());
  const stats = useMemo(() => ({
    today: initialEntries.filter((entry) =>
      entry.reservationStatus === "CONFIRMED" && kstDateKey(entry.scheduledAt) === todayKey,
    ).length,
    attention: initialEntries.filter(needsAttention).length,
    processing: initialEntries.filter((entry) => PROCESSING_STATUSES.has(entry.status)).length,
    delivered: initialEntries.filter((entry) => entry.status === "DELIVERED").length,
  }), [initialEntries, todayKey]);

  const filteredEntries = useMemo(() => initialEntries
    .filter((entry) => matchesFilter(entry, filter))
    .sort((left, right) => {
      const weight = sortWeight(left) - sortWeight(right);
      if (weight !== 0) return weight;
      if (left.status === "DELIVERED" && right.status === "DELIVERED") {
        return new Date(right.sentAt || right.startTime).getTime() - new Date(left.sentAt || left.startTime).getTime();
      }
      return new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime();
    }), [filter, initialEntries]);

  const filters: Array<{ key: Filter; label: string }> = [
    { key: "ALL", label: "전체" },
    { key: "ATTENTION", label: "확인 필요" },
    { key: "PROCESSING", label: "처리 중" },
    { key: "SCHEDULED", label: "발송 예정" },
    { key: "DELIVERED", label: "수신 완료" },
  ];

  return (
    <div className="min-h-full bg-slate-50 px-4 pb-24 pt-16 sm:px-6 md:pb-8 md:pt-20 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-center gap-3">
          <div className="rounded-2xl bg-indigo-600 p-3 text-white shadow-sm">
            <MessageSquareText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">문자 발송현황</h1>
            <p className="mt-1 text-sm text-slate-500">예약 2시간 전 발송부터 고객 휴대폰 수신 결과까지 확인합니다.</p>
          </div>
        </header>

        <PushNotificationSetup />

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "오늘 발송 대상", value: stats.today, icon: CalendarClock, tone: "text-sky-600 bg-sky-50" },
            { label: "확인 필요", value: stats.attention, icon: AlertTriangle, tone: "text-rose-600 bg-rose-50" },
            { label: "처리 중", value: stats.processing, icon: Radio, tone: "text-indigo-600 bg-indigo-50" },
            { label: "수신 완료", value: stats.delivered, icon: CheckCheck, tone: "text-emerald-600 bg-emerald-50" },
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
            <div className="flex gap-2 overflow-x-auto pb-1">
              {filters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setFilter(item.key)}
                  className={`shrink-0 rounded-full px-4 py-2 text-xs font-extrabold transition ${
                    filter === item.key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {filteredEntries.map((entry) => {
              const style = statusStyle(entry.status);
              return (
                <article key={entry.reservationId} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-black text-slate-900">{entry.customerName || "이름 없음"}</p>
                        <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">{entry.roomName}</span>
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
                      {entry.sentAt ? `처리 ${formatKst(entry.sentAt)}` : "아직 발송 전"}
                    </div>
                  </div>
                </article>
              );
            })}
            {filteredEntries.length === 0 && (
              <div className="p-12 text-center text-sm text-slate-400">이 상태에 해당하는 예약이 없습니다.</div>
            )}
          </div>
        </section>

        <p className="px-1 text-xs leading-5 text-slate-500">
          ‘솔라피 접수’는 발송 요청이 들어간 상태이고, ‘수신 완료’는 통신사 결과가 확인된 최종 성공입니다. 결과는 5초마다 자동 갱신됩니다.
        </p>
      </div>
    </div>
  );
}
