"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  MessageSquareText,
  Coins,
  Radio,
  Send,
} from "lucide-react";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";
import { formatKoreanPhone } from "@/lib/phone-number";
import PushNotificationSetup from "@/components/PushNotificationSetup";
import type {
  SolapiDailyUsage,
  SolapiOperationalMessageDetail,
} from "@/lib/solapi-daily-usage";

type DeliveryEntry = {
  entryId: string;
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
  messageType: "GUIDE" | "DAWN_BOOKING" | "ON_TIME_EXIT" | "SITE_VISIT" | "UNPAID" | "SITUATION";
  messageLabel: string;
  onTimeExitAction?: {
    eligible: boolean;
    status: string | null;
    resultAt: string | null;
  } | null;
};

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  SCHEDULED: { label: "발송 예정", className: "bg-slate-100 text-slate-600 ring-slate-200" },
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
  SKIPPED: { label: "발송 제외", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  CANCELLED: { label: "예약 취소", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  PENDING: { label: "발송 예정", className: "bg-slate-100 text-slate-600 ring-slate-200" },
};

const ATTENTION_STATUSES = new Set(["FAILED", "MISSING_PHONE", "OVERDUE", "DRY_RUN"]);
const PROCESSING_STATUSES = new Set(["SENDING", "RECOVERING", "SUBMITTED", "CARRIER_ACCEPTED"]);
const SCHEDULED_STATUSES = new Set(["SCHEDULED", "PENDING", "WAITING_CONTACT", "WAITING_CONTACT_SYNC"]);

type MessageFilter = "ALL" | "GUIDE" | "SITUATION" | "UNSENT";

const MESSAGE_FILTERS: Array<{ value: MessageFilter; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "GUIDE", label: "이용 안내" },
  { value: "SITUATION", label: "상황별" },
  { value: "UNSENT", label: "미발송/실패" },
];

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

function roomBadgeStyle(roomName: string) {
  switch (roomName) {
    case "머무룸1":
      return "border-sky-100 bg-sky-50 text-sky-700";
    case "머무룸2":
      return "border-purple-100 bg-purple-50 text-purple-700";
    case "머무룸3":
      return "border-orange-200 bg-orange-50 text-orange-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function messageTypeBadgeStyle(messageType: DeliveryEntry["messageType"]) {
  switch (messageType) {
    case "DAWN_BOOKING":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "ON_TIME_EXIT":
      return "bg-indigo-50 text-indigo-700 ring-indigo-200";
    case "SITE_VISIT":
      return "bg-sky-50 text-sky-700 ring-sky-200";
    case "UNPAID":
      return "bg-rose-50 text-rose-700 ring-rose-200";
    case "SITUATION":
      return "bg-orange-50 text-orange-700 ring-orange-200";
    default:
      return "bg-slate-100 text-slate-600 ring-slate-200";
  }
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

function onTimeExitStatusLabel(status: string) {
  if (status === "DELIVERED") return "정시퇴실 수신 완료";
  if (status === "FAILED") return "정시퇴실 발송 실패";
  if (status === "DRY_RUN") return "정시퇴실 테스트 완료";
  return "정시퇴실 발송됨";
}

function OperationalWarningDetails({
  details,
  className,
}: {
  details: SolapiOperationalMessageDetail[];
  className: string;
}) {
  return (
    <section className={className}>
      <div className="border-b border-amber-100 bg-amber-50 px-4 py-3">
        <h2 className="text-sm font-black text-amber-900">운영 경고 문자 상세</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {details.map((detail) => {
          const statusClass = detail.status === "DELIVERED"
            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
            : detail.status === "FAILED"
              ? "bg-rose-50 text-rose-700 ring-rose-200"
              : "bg-indigo-50 text-indigo-700 ring-indigo-200";
          return (
            <article key={detail.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-extrabold text-amber-800 ring-1 ring-inset ring-amber-200">
                  {detail.label}
                </span>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ring-inset ${statusClass}`}>
                  {detail.statusLabel}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  {detail.sentAt ? formatKst(detail.sentAt) : "발송 시각 확인 불가"}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-slate-700">
                {detail.text}
              </p>
              {detail.recipient && (
                <p className="mt-1 text-xs text-slate-400">수신자 {formatKoreanPhone(detail.recipient)}</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function MessagesView({
  initialEntries,
  dailyUsage,
  selectedDateKey,
  selectedDateLabel,
  isToday,
}: {
  initialEntries: DeliveryEntry[];
  dailyUsage: SolapiDailyUsage;
  selectedDateKey: string;
  selectedDateLabel: string;
  isToday: boolean;
}) {
  const router = useRouter();
  const [showOperationalDetails, setShowOperationalDetails] = useState(false);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("ALL");
  const [sendingOnTimeExitId, setSendingOnTimeExitId] = useState<string | null>(null);
  const [onTimeExitErrors, setOnTimeExitErrors] = useState<Record<string, string>>({});
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

  const filteredEntries = useMemo(() => sortedEntries.filter((entry) => {
    if (entry.messageType === "ON_TIME_EXIT") return messageFilter === "SITUATION";
    if (messageFilter === "GUIDE") return entry.messageType === "GUIDE";
    if (messageFilter === "SITUATION") return entry.messageType !== "GUIDE";
    if (messageFilter === "UNSENT") {
      return SCHEDULED_STATUSES.has(entry.status)
        || PROCESSING_STATUSES.has(entry.status)
        || ATTENTION_STATUSES.has(entry.status);
    }
    return true;
  }), [messageFilter, sortedEntries]);

  const [selectedYear, selectedMonth, selectedDay] = selectedDateKey.split("-").map(Number);
  const currentYear = new Date().getFullYear();
  const firstYear = Math.min(2025, selectedYear - 1);
  const lastYear = Math.max(currentYear + 1, selectedYear + 1);
  const yearOptions = Array.from(
    { length: lastYear - firstYear + 1 },
    (_, index) => firstYear + index,
  );
  const daysInSelectedMonth = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();
  const operationalBreakdown = [
    dailyUsage.operational.tailscaleCount > 0
      ? `Tailscale ${dailyUsage.operational.tailscaleCount}건`
      : null,
    dailyUsage.operational.serverCount > 0
      ? `서버 ${dailyUsage.operational.serverCount}건`
      : null,
    dailyUsage.operational.otherCount > 0
      ? `기타 ${dailyUsage.operational.otherCount}건`
      : null,
  ].filter((value): value is string => Boolean(value));

  function moveToDate(year: number, month: number, day: number) {
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const safeDay = Math.min(day, maxDay);
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
    router.replace(`/messages?date=${dateKey}`);
  }

  function processingLabel(entry: DeliveryEntry) {
    const value = entry.resultAt || entry.sentAt;
    if (entry.status === "DELIVERED") return value ? `수신 완료 ${formatKst(value)}` : "수신 완료";
    if (needsAttention(entry)) return value ? `확인 필요 ${formatKst(value)}` : "확인 필요";
    if (entry.status === "CARRIER_ACCEPTED") return value ? `통신사 처리 중 ${formatKst(value)}` : "통신사 처리 중";
    if (entry.status === "SUBMITTED") return value ? `솔라피 접수 ${formatKst(value)}` : "솔라피 접수";
    if (entry.status === "RECOVERING") return "솔라피 발송 이력 확인 중";
    if (entry.status === "SENDING") return "발송 작업 중";
    if (entry.status === "SKIPPED") return "자동문자 발송 제외";
    return `발송 예정 ${formatKst(entry.scheduledAt)}`;
  }

  function formatCost(value: number) {
    return `${Math.round(value).toLocaleString("ko-KR")}원`;
  }

  async function sendOnTimeExitMessage(entry: DeliveryEntry) {
    if (!entry.onTimeExitAction?.eligible || sendingOnTimeExitId) return;

    setSendingOnTimeExitId(entry.reservationId);
    setOnTimeExitErrors((current) => ({ ...current, [entry.reservationId]: "" }));
    try {
      const response = await fetch("/api/messages/on-time-exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: entry.reservationId }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "정시퇴실 문자 발송에 실패했습니다.");
      }
      router.refresh();
    } catch (error) {
      setOnTimeExitErrors((current) => ({
        ...current,
        [entry.reservationId]: error instanceof Error ? error.message : "정시퇴실 문자 발송에 실패했습니다.",
      }));
    } finally {
      setSendingOnTimeExitId(null);
    }
  }

  return (
    <div className="min-h-full bg-slate-50 px-4 pb-24 pt-16 sm:px-6 md:pb-8 md:pt-20 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-indigo-600 p-3 text-white shadow-sm">
              <MessageSquareText className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-900">
                {isToday ? "오늘 문자 현황" : `${selectedDateLabel} 문자 현황`}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <select
              aria-label="문자 조회 연도"
              value={selectedYear}
              onChange={(event) => moveToDate(Number(event.target.value), selectedMonth, selectedDay)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-bold text-slate-700 outline-hidden focus:border-indigo-300"
            >
              {yearOptions.map((year) => <option key={year} value={year}>{year}년</option>)}
            </select>
            <select
              aria-label="문자 조회 월"
              value={selectedMonth}
              onChange={(event) => moveToDate(selectedYear, Number(event.target.value), selectedDay)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-bold text-slate-700 outline-hidden focus:border-indigo-300"
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                <option key={month} value={month}>{month}월</option>
              ))}
            </select>
            <select
              aria-label="문자 조회 일"
              value={selectedDay}
              onChange={(event) => moveToDate(selectedYear, selectedMonth, Number(event.target.value))}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs font-bold text-slate-700 outline-hidden focus:border-indigo-300"
            >
              {Array.from({ length: daysInSelectedMonth }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{day}일</option>
              ))}
            </select>
            {!isToday && (
              <button
                type="button"
                onClick={() => router.replace("/messages")}
                className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-700"
              >
                오늘
              </button>
            )}
          </div>
        </header>

        <PushNotificationSetup />

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-1">
            <div className="inline-flex rounded-xl bg-amber-50 p-2 text-amber-600"><Coins className="h-5 w-5" /></div>
            <p className="mt-3 text-xs font-bold text-slate-500">
              {isToday ? "오늘" : selectedDateLabel} 총 사용액
            </p>
            <p className="mt-1 text-2xl font-black text-slate-900">
              {dailyUsage.available ? formatCost(dailyUsage.totalCost) : "확인 실패"}
            </p>
            <p className="mt-2 text-[11px] font-semibold leading-5 text-slate-500">
              안내 {dailyUsage.reservation.count}건 · 경고 {dailyUsage.operational.count}건 · 기타 {dailyUsage.other.count}건
            </p>
            {operationalBreakdown.length > 0 && (
              <button
                type="button"
                onClick={() => setShowOperationalDetails((current) => !current)}
                aria-expanded={showOperationalDetails}
                className="mt-1.5 flex w-full items-center justify-between gap-2 text-left text-[11px] font-bold text-amber-700"
              >
                <span>{operationalBreakdown.join(" · ")}</span>
                {showOperationalDetails
                  ? <ChevronUp className="h-3.5 w-3.5 shrink-0" />
                  : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
              </button>
            )}
            {showOperationalDetails && dailyUsage.operational.details.length > 0 && (
              <OperationalWarningDetails
                details={dailyUsage.operational.details}
                className="mt-3 overflow-hidden rounded-xl border border-amber-200 bg-white lg:hidden"
              />
            )}
          </div>
          {[
            { label: "발송 예정", value: stats.scheduled, icon: CalendarClock, tone: "text-slate-500 bg-slate-100" },
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

        {showOperationalDetails && dailyUsage.operational.details.length > 0 && (
          <OperationalWarningDetails
            details={dailyUsage.operational.details}
            className="hidden overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm lg:block"
          />
        )}

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5">
            <h2 className="font-black text-slate-900">{selectedDateLabel} 발송 관리</h2>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5">
              {MESSAGE_FILTERS.map((filter) => {
                const active = messageFilter === filter.value;
                return (
                  <button
                    key={filter.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMessageFilter(filter.value)}
                    className={`shrink-0 rounded-full px-3 py-2 text-xs font-extrabold transition-colors ${
                      active
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {filteredEntries.map((entry) => {
              const style = statusStyle(entry.status);
              return (
                <article key={entry.entryId} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md border px-2 py-1 text-[11px] font-bold ${roomBadgeStyle(entry.roomName)}`}>
                          {entry.roomName}
                        </span>
                        <p className="font-black text-slate-900">{entry.customerName || "이름 없음"}</p>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ring-inset ${messageTypeBadgeStyle(entry.messageType)}`}>
                          {entry.messageLabel}
                        </span>
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
                        {entry.messageType === "GUIDE" ? "발송예정" : "발송시도"} {formatKst(entry.scheduledAt)}
                      </p>
                      {entry.error && (
                        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{entry.error}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {entry.messageType === "GUIDE" && entry.onTimeExitAction?.eligible && (
                        <button
                          type="button"
                          onClick={() => void sendOnTimeExitMessage(entry)}
                          disabled={Boolean(sendingOnTimeExitId)}
                          className={`mb-1.5 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-black ring-1 ring-inset transition disabled:cursor-wait ${
                            sendingOnTimeExitId === entry.reservationId
                              ? "bg-slate-800 text-white ring-slate-800"
                              : "bg-slate-100 text-slate-700 ring-slate-200 hover:bg-slate-200"
                          }`}
                        >
                          <Send className="h-3.5 w-3.5" />
                          {sendingOnTimeExitId === entry.reservationId
                            ? "정시퇴실 발송 중"
                            : "정시퇴실 지금 보내기"}
                        </button>
                      )}
                      {entry.messageType === "GUIDE" && entry.onTimeExitAction?.status && (
                        <span className={`mb-1.5 rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ring-inset ${
                          entry.onTimeExitAction.status === "DELIVERED"
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                            : entry.onTimeExitAction.status === "FAILED"
                              ? "bg-rose-50 text-rose-700 ring-rose-200"
                              : "bg-indigo-50 text-indigo-700 ring-indigo-200"
                        }`}>
                          {onTimeExitStatusLabel(entry.onTimeExitAction.status)}
                        </span>
                      )}
                      {onTimeExitErrors[entry.reservationId] && (
                        <p className="max-w-xs rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                          {onTimeExitErrors[entry.reservationId]}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <Clock3 className="h-4 w-4" />
                        {processingLabel(entry)}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
            {filteredEntries.length === 0 && (
              <div className="p-12 text-center text-sm text-slate-400">
                {messageFilter === "ALL"
                  ? "선택한 날짜의 문자 내역이 없습니다."
                  : "선택한 조건에 해당하는 문자 내역이 없습니다."}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
