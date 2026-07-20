"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCheck,
  MessageSquareText,
  Search,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";
import { formatKoreanPhone } from "@/lib/phone-number";

type ReservationSummary = {
  id: string;
  customerName: string | null;
  roomName: string;
  startTime: string;
  endTime: string;
  status: string;
};

type MessageRecord = {
  id: string;
  direction: string;
  channel: string;
  status: string;
  senderNumber: string;
  recipientNumber: string;
  customerPhone: string;
  body: string;
  occurredAt: string;
  readAt: string | null;
  bridgeDeviceName: string | null;
  reservation: ReservationSummary | null;
};

type BridgeDevice = {
  id: string;
  name: string;
  phoneNumber: string;
  enabled: boolean;
  connected: boolean;
  lastSeenAt: string | null;
};

type Conversation = {
  phone: string;
  name: string;
  messages: MessageRecord[];
  latest: MessageRecord;
  unreadCount: number;
  reservation: ReservationSummary | null;
};

function formatKstDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatReservation(value: ReservationSummary) {
  const start = new Date(value.startTime);
  const end = new Date(value.endTime);
  const date = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
  }).format(start);
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time.format(start)}-${time.format(end)} · ${value.roomName}`;
}

function deviceState(device: BridgeDevice) {
  if (!device.enabled) return { label: "사용 중지", className: "bg-slate-100 text-slate-500" };
  if (!device.connected) return { label: "연결 전", className: "bg-amber-50 text-amber-700" };
  if (!device.lastSeenAt) return { label: "등록됨", className: "bg-indigo-50 text-indigo-700" };
  const age = Date.now() - new Date(device.lastSeenAt).getTime();
  if (age < 30 * 60 * 1000) {
    return { label: "최근 수신 정상", className: "bg-emerald-50 text-emerald-700" };
  }
  return { label: `마지막 수신 ${formatKstDateTime(device.lastSeenAt)}`, className: "bg-slate-100 text-slate-600" };
}

export default function MessagesView({
  initialMessages,
  devices,
}: {
  initialMessages: MessageRecord[];
  devices: BridgeDevice[];
}) {
  const router = useRouter();
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [optimisticallyReadPhones, setOptimisticallyReadPhones] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");

  const messages = useMemo(() => initialMessages.map((message) =>
    optimisticallyReadPhones.has(message.customerPhone) && message.direction === "INBOUND" && !message.readAt
      ? { ...message, readAt: new Date().toISOString() }
      : message,
  ), [initialMessages, optimisticallyReadPhones]);

  const conversations = useMemo(() => {
    const grouped = new Map<string, MessageRecord[]>();
    for (const message of messages) {
      const list = grouped.get(message.customerPhone) || [];
      list.push(message);
      grouped.set(message.customerPhone, list);
    }

    return Array.from(grouped.entries())
      .map(([phone, conversationMessages]): Conversation => {
        const latest = conversationMessages[conversationMessages.length - 1];
        const reservation = [...conversationMessages]
          .reverse()
          .find((message) => message.reservation)?.reservation || null;
        return {
          phone,
          name: reservation?.customerName?.trim() || `고객 ${phone.slice(-4)}`,
          messages: conversationMessages,
          latest,
          reservation,
          unreadCount: conversationMessages.filter(
            (message) => message.direction === "INBOUND" && !message.readAt,
          ).length,
        };
      })
      .sort((a, b) => new Date(b.latest.occurredAt).getTime() - new Date(a.latest.occurredAt).getTime());
  }, [messages]);

  const filteredConversations = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return conversations;
    const digits = keyword.replace(/\D/g, "");
    return conversations.filter((conversation) =>
      conversation.name.toLowerCase().includes(keyword) ||
      (digits && conversation.phone.includes(digits)) ||
      conversation.latest.body.toLowerCase().includes(keyword),
    );
  }, [conversations, search]);

  const refresh = useCallback(() => router.refresh(), [router]);
  useDataChangePolling("/api/data-version?scope=messages", refresh, { intervalMs: 5_000 });

  const fallbackPhone = conversations.find((item) => item.unreadCount > 0)?.phone || conversations[0]?.phone || null;
  const activePhone = selectedPhone && conversations.some((item) => item.phone === selectedPhone)
    ? selectedPhone
    : fallbackPhone;
  const selectedConversation = conversations.find((item) => item.phone === activePhone) || null;

  const openConversation = async (phone: string) => {
    setSelectedPhone(phone);
    setOptimisticallyReadPhones((current) => new Set(current).add(phone));
    try {
      await fetch("/api/messages/read", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerPhone: phone }),
      });
    } catch (error) {
      console.error("Failed to mark conversation as read:", error);
    }
  };

  return (
    <div className="min-h-full bg-slate-50 px-4 pb-24 pt-16 sm:px-6 md:pb-8 md:pt-20 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-indigo-600 p-3 text-white shadow-sm">
              <MessageSquareText className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-900">고객 문자함</h1>
              <p className="mt-1 text-sm text-slate-500">솔라피 발송 기록과 휴대폰으로 온 고객 답장을 한곳에서 확인합니다.</p>
            </div>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2">
          {devices.length === 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:col-span-2">
              휴대폰 문자 수신 연결을 준비 중입니다. 연결 전에도 솔라피 발송 기록은 이 화면에 쌓입니다.
            </div>
          ) : devices.map((device) => {
            const state = deviceState(device);
            return (
              <div key={device.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <Smartphone className="h-5 w-5 shrink-0 text-indigo-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-900">{device.name}</p>
                    <p className="text-xs text-slate-500">{formatKoreanPhone(device.phoneNumber)}</p>
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${state.className}`}>{state.label}</span>
              </div>
            );
          })}
        </section>

        <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          예약자 전화번호와 정확히 일치하는 문자만 저장합니다. 개인 문자와 인증번호는 서버에 보관하지 않습니다.
        </div>

        <section className="grid min-h-[620px] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[330px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="border-b border-slate-100 p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="이름·전화번호·내용 검색"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 focus:bg-white"
                />
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto lg:max-h-[650px]">
              {filteredConversations.map((conversation) => (
                <button
                  key={conversation.phone}
                  type="button"
                  onClick={() => void openConversation(conversation.phone)}
                  className={`w-full border-b border-slate-100 p-4 text-left transition ${
                    activePhone === conversation.phone ? "bg-indigo-50" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-extrabold text-slate-900">{conversation.name}</p>
                    <span className="shrink-0 text-[11px] text-slate-400">{formatKstDateTime(conversation.latest.occurredAt)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs text-slate-500">{conversation.latest.body}</p>
                    {conversation.unreadCount > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-black text-white">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {filteredConversations.length === 0 && (
                <p className="p-8 text-center text-sm text-slate-400">표시할 고객 대화가 없습니다.</p>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-col">
            {selectedConversation ? (
              <>
                <div className="border-b border-slate-200 px-4 py-4 sm:px-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-black text-slate-900">{selectedConversation.name}</h2>
                      <p className="text-xs text-slate-500">{formatKoreanPhone(selectedConversation.phone)}</p>
                    </div>
                    {selectedConversation.reservation && (
                      <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">
                        {formatReservation(selectedConversation.reservation)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
                  {selectedConversation.messages.map((message) => {
                    const outbound = message.direction === "OUTBOUND";
                    return (
                      <div key={message.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[86%] sm:max-w-[72%] ${outbound ? "items-end" : "items-start"}`}>
                          <div className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                            outbound
                              ? "rounded-br-md bg-indigo-600 text-white"
                              : "rounded-bl-md border border-slate-200 bg-white text-slate-800"
                          }`}>
                            {message.body}
                          </div>
                          <div className={`mt-1 flex items-center gap-1.5 px-1 text-[11px] text-slate-400 ${outbound ? "justify-end" : "justify-start"}`}>
                            <span>{formatKstDateTime(message.occurredAt)}</span>
                            <span>·</span>
                            <span>{outbound ? `발신 ${formatKoreanPhone(message.senderNumber)}` : `${message.bridgeDeviceName || "휴대폰"} 수신`}</span>
                            {outbound && message.status === "SENT" && <CheckCheck className="h-3.5 w-3.5 text-indigo-500" />}
                            {outbound && message.status === "DRY_RUN" && <span className="font-bold text-amber-600">테스트</span>}
                            {outbound && message.status === "FAILED" && <span className="font-bold text-rose-600">실패</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-slate-400">
                <MessageSquareText className="h-12 w-12" />
                <p className="text-sm">고객 대화를 선택하면 발송 내용과 답장을 함께 볼 수 있습니다.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
