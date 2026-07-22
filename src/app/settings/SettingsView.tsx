"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CircleDollarSign,
  CheckCircle2,
  ContactRound,
  MessageSquareText,
  Phone,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
  WalletCards,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SolapiServiceStatus } from "@/lib/solapi-status";
import type { IspProxyStatus } from "@/lib/proxy-status-types";
import type { ProxyPaymentCurrency, ProxyPaymentRecord } from "@/lib/proxy-payment-types";
import type { GooglePeopleStatus } from "@/lib/google-people";

type MessageTemplateState = {
  id: string;
  roomName: string;
  title: string;
  content: string;
  updatedAt: string;
};

type SettingsTab = "message" | "rpa";

const SOLAPI_SENDER_LABELS: Record<string, string> = {
  "01071835720": "사장님",
  "01094431849": "와이프",
};

type ProxyPaymentForm = {
  provider: string;
  paidOn: string;
  amount: string;
  currency: ProxyPaymentCurrency;
  vatIncluded: boolean;
  periodStart: string;
  periodEnd: string;
  note: string;
};

function todayInSeoul() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function emptyProxyPaymentForm(): ProxyPaymentForm {
  return {
    provider: "Proxy-Seller",
    paidOn: todayInSeoul(),
    amount: "",
    currency: "USD",
    vatIncluded: true,
    periodStart: "",
    periodEnd: "",
    note: "",
  };
}

function formatProxyPaymentAmount(amountMinor: number, currency: ProxyPaymentCurrency) {
  if (currency === "KRW") return `${amountMinor.toLocaleString("ko-KR")}원`;
  return `US$${(amountMinor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatWon(value: number | null) {
  if (value === null) return "-";
  return `${Math.round(value).toLocaleString()}원`;
}

function formatPhone(value: string | null) {
  if (!value) return "-";
  if (value.length === 11) return `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7)}`;
  return value;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}.${match[2]}.${match[3]}`;
  return value;
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function senderStatusLabel(status: string | null) {
  switch (status) {
    case "ACTIVE":
      return "사용 가능";
    case "PENDING":
      return "심사/인증 대기";
    case "INACTIVE":
      return "비활성";
    case "BLOCKED":
      return "차단";
    case "DUPLICATED":
      return "중복";
    case "EXPIRED":
      return "만료";
    case "OVERLIMIT":
      return "등록 한도 초과";
    default:
      return status || "확인필요";
  }
}

function senderStatusClass(status: string | null, error: string | null) {
  if (error) return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "ACTIVE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "PENDING") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function senderOwnerLabel(phoneNumber: string) {
  return SOLAPI_SENDER_LABELS[phoneNumber] || "등록 발신번호";
}

function proxyStatusClass(status: IspProxyStatus) {
  if (status.severity === "NOT_CONFIGURED") return "border-slate-200 bg-slate-50 text-slate-600";
  if (status.severity === "ERROR") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status.severity === "WARNING") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function remainingLabel(days: number | null) {
  if (days === null) return "-";
  if (days < 0) return `${Math.abs(days)}일 지남`;
  if (days === 0) return "오늘 만료";
  return `${days}일 남음`;
}

function countryLabel(value: string | null) {
  if (!value) return "-";
  return value === "KR" ? "대한민국" : value;
}

function orderStatusLabel(value: string | null) {
  if (!value) return "확인 필요";
  return ["ACTIVE", "ACTIVATED", "ON", "WORKING"].includes(value.toUpperCase()) ? "활성" : value;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-b-0">
      <span className="text-sm font-semibold text-slate-500">{label}</span>
      <span className="text-right text-sm font-bold text-slate-900">{value}</span>
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-black transition",
        active ? "bg-slate-950 text-white shadow-sm" : "bg-white text-slate-600 hover:bg-slate-100",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

export default function SettingsView({
  initialSolapiStatus,
  initialMessageTemplates,
  initialProxyStatus,
  initialProxyPayments,
  initialGooglePeopleStatus,
}: {
  initialSolapiStatus: SolapiServiceStatus;
  initialMessageTemplates: MessageTemplateState[];
  initialProxyStatus: IspProxyStatus;
  initialProxyPayments: ProxyPaymentRecord[];
  initialGooglePeopleStatus: GooglePeopleStatus;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("message");
  const [solapiStatus, setSolapiStatus] = useState<SolapiServiceStatus>(initialSolapiStatus);
  const [proxyStatus, setProxyStatus] = useState<IspProxyStatus>(initialProxyStatus);
  const [proxyPayments, setProxyPayments] = useState<ProxyPaymentRecord[]>(initialProxyPayments);
  const [proxyPaymentForm, setProxyPaymentForm] = useState<ProxyPaymentForm>(emptyProxyPaymentForm);
  const [templates, setTemplates] = useState<MessageTemplateState[]>(initialMessageTemplates);
  const [googlePeopleStatus, setGooglePeopleStatus] = useState<GooglePeopleStatus>(initialGooglePeopleStatus);
  const [isLoadingSolapi, setIsLoadingSolapi] = useState(false);
  const [selectedSenderNumber, setSelectedSenderNumber] = useState(initialSolapiStatus.senderNumber || "");
  const [isSavingSenderNumber, setIsSavingSenderNumber] = useState(false);
  const [senderSaveMessage, setSenderSaveMessage] = useState<string | null>(null);
  const [isLoadingProxy, setIsLoadingProxy] = useState(false);
  const [savingRoom, setSavingRoom] = useState<string | null>(null);
  const [isSavingProxyPayment, setIsSavingProxyPayment] = useState(false);
  const [deletingProxyPaymentId, setDeletingProxyPaymentId] = useState<string | null>(null);
  const [proxyPaymentMessage, setProxyPaymentMessage] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isSyncingGooglePeople, setIsSyncingGooglePeople] = useState(false);
  const [googlePeopleMessage, setGooglePeopleMessage] = useState<string | null>(null);

  const loadSolapiStatus = useCallback(async () => {
    setIsLoadingSolapi(true);
    try {
      const response = await fetch("/api/settings/solapi/status", { cache: "no-store" });
      const data = (await response.json()) as SolapiServiceStatus;
      setSolapiStatus(data);
      setSelectedSenderNumber(data.senderNumber || "");
    } finally {
      setIsLoadingSolapi(false);
    }
  }, []);

  const saveSenderNumber = async () => {
    if (!selectedSenderNumber) {
      setSenderSaveMessage("발신번호를 선택해주세요.");
      return;
    }

    setIsSavingSenderNumber(true);
    setSenderSaveMessage(null);
    try {
      const response = await fetch("/api/settings/solapi/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderNumber: selectedSenderNumber }),
      });
      const data = await response.json() as {
        success?: boolean;
        status?: SolapiServiceStatus;
        error?: string;
      };
      if (!response.ok || !data.success || !data.status) {
        throw new Error(data.error || "발신번호를 저장하지 못했습니다.");
      }

      setSolapiStatus(data.status);
      setSelectedSenderNumber(data.status.senderNumber || "");
      setSenderSaveMessage(`${formatPhone(data.status.senderNumber)} 번호를 문자 발신번호로 저장했습니다.`);
    } catch (error) {
      setSenderSaveMessage(error instanceof Error ? error.message : "발신번호를 저장하지 못했습니다.");
    } finally {
      setIsSavingSenderNumber(false);
    }
  };

  const loadProxyStatus = useCallback(async () => {
    setIsLoadingProxy(true);
    try {
      const response = await fetch("/api/proxy/status?refresh=1", { cache: "no-store" });
      if (!response.ok) throw new Error("ISP 프록시 상태를 확인하지 못했습니다.");
      const data = (await response.json()) as IspProxyStatus;
      setProxyStatus(data);
    } finally {
      setIsLoadingProxy(false);
    }
  }, []);

  const syncGooglePeople = async () => {
    setIsSyncingGooglePeople(true);
    setGooglePeopleMessage(null);
    try {
      const response = await fetch("/api/settings/google-people/status", { method: "POST" });
      const data = await response.json() as {
        success?: boolean;
        status?: GooglePeopleStatus;
        error?: string;
      };
      if (!response.ok || !data.success || !data.status) {
        throw new Error(data.error || "Google 연락처를 동기화하지 못했습니다.");
      }
      setGooglePeopleStatus(data.status);
      setGooglePeopleMessage("예약 고객 연락처 동기화를 완료했습니다.");
    } catch (error) {
      setGooglePeopleMessage(error instanceof Error ? error.message : "Google 연락처를 동기화하지 못했습니다.");
    } finally {
      setIsSyncingGooglePeople(false);
    }
  };

  const updateTemplateContent = (roomName: string, content: string) => {
    setTemplates((current) =>
      current.map((template) => template.roomName === roomName ? { ...template, content } : template),
    );
  };

  const saveTemplate = async (template: MessageTemplateState) => {
    setSavingRoom(template.roomName);
    setSaveMessage(null);
    try {
      const response = await fetch("/api/settings/message-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: template.roomName, content: template.content }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "템플릿 저장 실패");

      setTemplates((current) =>
        current.map((item) =>
          item.roomName === template.roomName
            ? {
                ...item,
                content: data.template.content,
                updatedAt: data.template.updatedAt,
              }
            : item,
        ),
      );
      setSaveMessage(`${template.roomName} 문자 템플릿을 저장했습니다.`);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "템플릿 저장에 실패했습니다.");
    } finally {
      setSavingRoom(null);
      window.setTimeout(() => setSaveMessage(null), 4000);
    }
  };

  const updateProxyPaymentForm = <K extends keyof ProxyPaymentForm>(key: K, value: ProxyPaymentForm[K]) => {
    setProxyPaymentForm((current) => ({ ...current, [key]: value }));
  };

  const saveProxyPayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingProxyPayment(true);
    setProxyPaymentMessage(null);

    try {
      const response = await fetch("/api/settings/proxy-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proxyPaymentForm),
      });
      const data = await response.json() as {
        success?: boolean;
        payment?: ProxyPaymentRecord;
        error?: string;
      };
      if (!response.ok || !data.success || !data.payment) {
        throw new Error(data.error || "결제 내역을 저장하지 못했습니다.");
      }

      setProxyPayments((current) => [data.payment!, ...current]);
      setProxyPaymentForm((current) => ({
        ...emptyProxyPaymentForm(),
        provider: current.provider,
        currency: current.currency,
        vatIncluded: current.vatIncluded,
      }));
      setProxyPaymentMessage("프록시 결제 내역을 저장했습니다.");
    } catch (error) {
      setProxyPaymentMessage(error instanceof Error ? error.message : "결제 내역을 저장하지 못했습니다.");
    } finally {
      setIsSavingProxyPayment(false);
    }
  };

  const deleteProxyPayment = async (payment: ProxyPaymentRecord) => {
    if (!window.confirm(`${formatDate(payment.paidOn)} 결제 내역을 삭제할까요?`)) return;

    setDeletingProxyPaymentId(payment.id);
    setProxyPaymentMessage(null);
    try {
      const response = await fetch("/api/settings/proxy-payments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payment.id }),
      });
      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !data.success) throw new Error(data.error || "결제 내역을 삭제하지 못했습니다.");

      setProxyPayments((current) => current.filter((item) => item.id !== payment.id));
      setProxyPaymentMessage("프록시 결제 내역을 삭제했습니다.");
    } catch (error) {
      setProxyPaymentMessage(error instanceof Error ? error.message : "결제 내역을 삭제하지 못했습니다.");
    } finally {
      setDeletingProxyPaymentId(null);
    }
  };

  const sender = solapiStatus.sender ?? null;
  const senderStatus = senderStatusLabel(sender?.status ?? null);
  const renewalText = sender?.expireAt
    ? formatDateTime(sender.expireAt)
    : sender?.autoExtension ? "자동연장" : "-";
  const proxyPaymentTotals = proxyPayments.reduce<Record<ProxyPaymentCurrency, number>>(
    (totals, payment) => {
      totals[payment.currency] += payment.amountMinor;
      return totals;
    },
    { USD: 0, KRW: 0 },
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 pb-24 md:p-8">
      <header className="space-y-4 pt-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">설정</h1>
          <p className="mt-1 text-sm text-slate-500">프로그램 운영에 필요한 메시지, RPA, 외부 연동 상태를 관리합니다.</p>
        </div>

        <div className="flex w-full gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1">
          <TabButton
            active={activeTab === "message"}
            icon={MessageSquareText}
            label="메시지"
            onClick={() => setActiveTab("message")}
          />
          <TabButton
            active={activeTab === "rpa"}
            icon={Bot}
            label="RPA"
            onClick={() => setActiveTab("rpa")}
          />
        </div>
      </header>

      {saveMessage && (
        <section className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-800">
          {saveMessage}
        </section>
      )}

      {activeTab === "message" && (
        <div className="space-y-5">
          {solapiStatus.error && (
            <section className="flex gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-900">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
              <div>
                <p className="text-sm font-black">솔라피 상태 확인 실패</p>
                <p className="mt-1 text-xs font-semibold text-rose-700">{solapiStatus.error}</p>
              </div>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-500">솔라피 총 보유액</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                    {formatWon(solapiStatus.totalBalance)}
                  </p>
                </div>
                <div className="rounded-full bg-emerald-50 p-3 text-emerald-600">
                  <WalletCards className="h-6 w-6" />
                </div>
              </div>
              <div className="mt-5 space-y-1 text-sm">
                <InfoRow label="잔액" value={formatWon(solapiStatus.balanceOnly ?? solapiStatus.balance)} />
                <InfoRow label="예치금" value={formatWon(solapiStatus.deposit)} />
                <InfoRow label="포인트" value={formatWon(solapiStatus.point)} />
                <InfoRow label="자동충전 기준" value={formatWon(solapiStatus.minimumCash)} />
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-500">발신번호</p>
                  <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                    {formatPhone(sender?.phoneNumber ?? solapiStatus.senderNumber)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black", senderStatusClass(sender?.status ?? null, solapiStatus.error))}>
                    {sender?.status === "ACTIVE" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                    {senderStatus}
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadSolapiStatus()}
                    disabled={isLoadingSolapi}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", isLoadingSolapi && "animate-spin")} />
                    새로고침
                  </button>
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div>
                  <h3 className="text-sm font-black text-slate-900">문자 발신번호 선택</h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    저장한 번호가 다음 실제 문자 발송부터 적용됩니다.
                  </p>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {solapiStatus.senders.map((senderOption) => {
                    const isSelected = selectedSenderNumber === senderOption.phoneNumber;
                    const isAvailable = senderOption.status === "ACTIVE";
                    return (
                      <label
                        key={senderOption.phoneNumber}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border bg-white p-3 transition",
                          isSelected ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200 hover:border-slate-300",
                          !isAvailable && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <input
                          type="radio"
                          name="solapiSenderNumber"
                          value={senderOption.phoneNumber}
                          checked={isSelected}
                          disabled={!isAvailable || isSavingSenderNumber}
                          onChange={() => setSelectedSenderNumber(senderOption.phoneNumber)}
                          className="h-4 w-4 accent-indigo-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-black text-slate-900">
                              {senderOwnerLabel(senderOption.phoneNumber)}
                            </span>
                            <span className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-black",
                              senderStatusClass(senderOption.status, null),
                            )}>
                              {senderStatusLabel(senderOption.status)}
                            </span>
                          </div>
                          <p className="mt-1 text-sm font-bold text-slate-600">
                            {formatPhone(senderOption.phoneNumber)}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {solapiStatus.senders.length === 0 && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                    선택할 수 있는 등록 발신번호를 불러오지 못했습니다.
                  </p>
                )}

                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className={cn(
                    "text-xs font-bold",
                    senderSaveMessage?.includes("저장했습니다") ? "text-emerald-700" : "text-rose-700",
                  )}>
                    {senderSaveMessage}
                  </p>
                  <button
                    type="button"
                    onClick={() => void saveSenderNumber()}
                    disabled={
                      isSavingSenderNumber
                      || !selectedSenderNumber
                      || selectedSenderNumber === solapiStatus.senderNumber
                    }
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-black text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                  >
                    {isSavingSenderNumber ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    발신번호 저장
                  </button>
                </div>

                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-relaxed text-amber-800">
                  솔라피로 보낸 문자는 휴대폰 기본 메시지 앱의 보낸 내역과 자동으로 동기화되지 않습니다.
                </p>
              </div>

              <div className="mt-5 grid gap-x-8 md:grid-cols-2">
                <InfoRow label="갱신/만료일" value={renewalText} />
                <InfoRow label="자동연장" value={sender?.autoExtension === null || sender?.autoExtension === undefined ? "-" : sender.autoExtension ? "사용" : "미사용"} />
                <InfoRow label="인증 방식" value={sender?.method || "-"} />
                <InfoRow label="등록 가능 개수" value={solapiStatus.senderLimit === null ? "-" : `${solapiStatus.senderLimit}개`} />
                <InfoRow label="등록일" value={formatDateTime(sender?.dateCreated ?? null)} />
                <InfoRow label="최근 수정일" value={formatDateTime(sender?.dateUpdated ?? null)} />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                <div className={cn(
                  "h-fit rounded-full p-3",
                  googlePeopleStatus.connected ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600",
                )}>
                  <ContactRound className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-slate-900">와이프 아이폰 연락처 자동저장</h2>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    7일 이내 예약 고객을 <span className="font-black text-slate-700">머무룸3 7/23 김종성</span> 형식으로 저장합니다. 취소 시 삭제하고 이용 종료 48시간 후 정리합니다.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black",
                  googlePeopleStatus.connected
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700",
                )}>
                  {googlePeopleStatus.connected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {googlePeopleStatus.connected ? "연결됨" : "와이프 계정 연결 필요"}
                </span>
                <button
                  type="button"
                  onClick={() => void syncGooglePeople()}
                  disabled={!googlePeopleStatus.connected || isSyncingGooglePeople}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-2 text-xs font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isSyncingGooglePeople && "animate-spin")} />
                  지금 동기화
                </button>
              </div>
            </div>

            <div className="mt-5 grid gap-x-8 md:grid-cols-2">
              <InfoRow label="연결 계정" value={googlePeopleStatus.accountEmail || "와이프 Google 계정 연결 전"} />
              <InfoRow label="최근 성공" value={formatDateTime(googlePeopleStatus.lastSuccessAt)} />
              <InfoRow label="확인한 고객" value={`${googlePeopleStatus.checkedCount}명`} />
              <InfoRow label="최근 처리" value={`신규 ${googlePeopleStatus.createdCount} · 갱신 ${googlePeopleStatus.updatedCount} · 동일 ${googlePeopleStatus.unchangedCount}`} />
              <InfoRow label="최근 정리" value={`삭제 ${googlePeopleStatus.deletedCount} · 원래 이름 복원 ${googlePeopleStatus.restoredCount}`} />
            </div>

            {!googlePeopleStatus.configured && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                서버 OAuth 설정을 준비 중입니다. 준비가 끝난 뒤 와이프 Google 계정으로 한 번만 승인하면 됩니다.
              </p>
            )}
            {googlePeopleStatus.lastError && (
              <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                최근 오류: {googlePeopleStatus.lastError}
              </p>
            )}
            {googlePeopleMessage && (
              <p className={cn(
                "mt-4 rounded-lg border px-3 py-2 text-xs font-bold",
                googlePeopleMessage.includes("완료")
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-800",
              )}>
                {googlePeopleMessage}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-black text-slate-900">문자 템플릿</h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                아래 내용이 예약 안내 문자 본문에 들어갑니다. 저장하면 다음 발송부터 바로 반영됩니다.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {templates.map((template) => (
                <div key={template.roomName} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-slate-900">{template.roomName}</p>
                      <p className="mt-0.5 text-xs font-semibold text-slate-400">
                        최근 수정 {formatDateTime(template.updatedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveTemplate(template)}
                      disabled={savingRoom === template.roomName}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-2 text-xs font-black text-white transition hover:bg-slate-800 disabled:opacity-60"
                    >
                      {savingRoom === template.roomName ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      저장
                    </button>
                  </div>
                  <textarea
                    value={template.content}
                    onChange={(event) => updateTemplateContent(template.roomName, event.target.value)}
                    className="mt-3 h-96 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm font-semibold leading-6 text-slate-800 outline-hidden transition focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100"
                    spellCheck={false}
                  />
                  <p className="mt-2 text-xs font-semibold text-slate-400">
                    이 내용이 실제 문자 본문으로 그대로 발송됩니다.
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === "rpa" && (
        <div className="space-y-5">
          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-500">ISP 프록시</p>
                  <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                    {proxyStatus.summary}
                  </p>
                  <p className="mt-1 text-xs font-bold text-slate-400">
                    {proxyStatus.provider} · {countryLabel(proxyStatus.detectedCountry || proxyStatus.country)}
                  </p>
                </div>
                <div className="rounded-full bg-sky-50 p-3 text-sky-600">
                  <Wifi className="h-6 w-6" />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex rounded-full border px-3 py-1 text-xs font-black", proxyStatusClass(proxyStatus))}>
                  {proxyStatus.severity === "OK" ? "정상" : proxyStatus.summary}
                </span>
                <button
                  type="button"
                  onClick={() => void loadProxyStatus()}
                  disabled={isLoadingProxy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isLoadingProxy && "animate-spin")} />
                  새로고침
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="flex items-center gap-2">
                <ServerCog className="h-5 w-5 text-slate-400" />
                <h2 className="text-base font-black text-slate-900">RPA 운영 상태</h2>
              </div>
              <div className="mt-4 grid gap-x-8 md:grid-cols-2">
                <InfoRow label="서비스" value={proxyStatus.provider} />
                <InfoRow label="주문 상태" value={orderStatusLabel(proxyStatus.orderStatus)} />
                <InfoRow label="실제 연결" value={proxyStatus.connectionOk ? `정상 · ${countryLabel(proxyStatus.detectedCountry)}` : "연결 실패"} />
                <InfoRow label="고정 IP 일치" value={proxyStatus.ipMatches === null ? "확인 필요" : proxyStatus.ipMatches ? "일치" : "불일치"} />
                <InfoRow label="등록 IP" value={proxyStatus.expectedIp || "-"} />
                <InfoRow label="접속 IP" value={proxyStatus.detectedIp || "-"} />
                <InfoRow label="통신망" value={proxyStatus.detectedOrganization || "-"} />
                <InfoRow label="관리 API" value={proxyStatus.apiOk ? "정상" : "확인 필요"} />
                <InfoRow
                  label="만료일"
                  value={<span className="font-black text-rose-600">{formatDate(proxyStatus.expiresOn)}</span>}
                />
                <InfoRow label="남은 기간" value={remainingLabel(proxyStatus.daysRemaining)} />
                <InfoRow label="자동연장" value={proxyStatus.autoRenew === null ? "확인 필요" : proxyStatus.autoRenew ? "사용" : "미사용"} />
                <InfoRow label="최근 확인" value={formatDateTime(proxyStatus.checkedAt)} />
                <InfoRow label="메일 확인 주기" value="15초" />
                <InfoRow label="프록시 확인 주기" value="5분" />
              </div>
              {proxyStatus.autoRenew === false && proxyStatus.daysRemaining !== null && proxyStatus.daysRemaining >= 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                  자동연장이 꺼져 있습니다. {formatDate(proxyStatus.expiresOn)} 전에 연장해야 같은 고정 IP를 유지할 수 있습니다.
                </div>
              )}
              {proxyStatus.error && proxyStatus.severity !== "OK" && (
                <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                  확인 내용: {proxyStatus.error}
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <CircleDollarSign className="h-5 w-5 text-emerald-600" />
                  <h2 className="text-base font-black text-slate-900">ISP 프록시 결제 내역</h2>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  카드에서 실제 결제된 최종 금액을 기록합니다. 달러와 원화는 환산하지 않고 따로 합산합니다.
                </p>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {proxyPaymentTotals.USD > 0 && (
                  <p>
                    <span className="font-semibold text-slate-500">달러 누계 </span>
                    <strong className="font-black text-slate-950">
                      {formatProxyPaymentAmount(proxyPaymentTotals.USD, "USD")}
                    </strong>
                  </p>
                )}
                {proxyPaymentTotals.KRW > 0 && (
                  <p>
                    <span className="font-semibold text-slate-500">원화 누계 </span>
                    <strong className="font-black text-slate-950">
                      {formatProxyPaymentAmount(proxyPaymentTotals.KRW, "KRW")}
                    </strong>
                  </p>
                )}
              </div>
            </div>

            <form onSubmit={(event) => void saveProxyPayment(event)} className="border-b border-slate-200 py-5">
              <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-bold leading-6 text-sky-900">
                입력 방법: 결제일 선택 → 카드에서 빠져나간 최종 금액 입력 → VAT 포함 여부 확인 → 내역 추가.
                사용기간과 메모는 몰라도 비워둘 수 있습니다.
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <label className="space-y-1.5">
                  <span className="text-xs font-black text-slate-600">결제일</span>
                  <input
                    type="date"
                    required
                    value={proxyPaymentForm.paidOn}
                    onChange={(event) => updateProxyPaymentForm("paidOn", event.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-hidden focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-black text-slate-600">업체</span>
                  <input
                    type="text"
                    required
                    maxLength={60}
                    value={proxyPaymentForm.provider}
                    onChange={(event) => updateProxyPaymentForm("provider", event.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-hidden focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
                <label className="space-y-1.5 lg:col-span-2">
                  <span className="text-xs font-black text-slate-600">최종 결제액</span>
                  <span className="flex h-11 overflow-hidden rounded-lg border border-slate-200 bg-white focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
                    <input
                      type="number"
                      required
                      min={proxyPaymentForm.currency === "USD" ? "0.01" : "1"}
                      step={proxyPaymentForm.currency === "USD" ? "0.01" : "1"}
                      inputMode="decimal"
                      placeholder={proxyPaymentForm.currency === "USD" ? "1.75" : "2500"}
                      value={proxyPaymentForm.amount}
                      onChange={(event) => updateProxyPaymentForm("amount", event.target.value)}
                      className="min-w-0 flex-1 px-3 text-sm font-black text-slate-900 outline-hidden"
                    />
                    <select
                      value={proxyPaymentForm.currency}
                      onChange={(event) => updateProxyPaymentForm("currency", event.target.value as ProxyPaymentCurrency)}
                      className="border-l border-slate-200 bg-slate-50 px-3 text-sm font-black text-slate-700 outline-hidden"
                    >
                      <option value="USD">USD</option>
                      <option value="KRW">KRW</option>
                    </select>
                  </span>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-black text-slate-600">사용 시작일 (선택)</span>
                  <input
                    type="date"
                    value={proxyPaymentForm.periodStart}
                    onChange={(event) => updateProxyPaymentForm("periodStart", event.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-hidden focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-black text-slate-600">사용 종료일 (선택)</span>
                  <input
                    type="date"
                    value={proxyPaymentForm.periodEnd}
                    onChange={(event) => updateProxyPaymentForm("periodEnd", event.target.value)}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-hidden focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
              </div>

              <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center">
                <label className="flex h-11 flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3">
                  <input
                    type="checkbox"
                    checked={proxyPaymentForm.vatIncluded}
                    onChange={(event) => updateProxyPaymentForm("vatIncluded", event.target.checked)}
                    className="h-4 w-4 accent-emerald-600"
                  />
                  <span className="text-sm font-bold text-slate-700">입력 금액에 VAT 포함</span>
                </label>
                <input
                  type="text"
                  maxLength={200}
                  placeholder="메모 (선택 · 예: 한국 고정 ISP IP 1개 · 1주)"
                  value={proxyPaymentForm.note}
                  onChange={(event) => updateProxyPaymentForm("note", event.target.value)}
                  className="h-11 min-w-0 flex-[2] rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-hidden focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  type="submit"
                  disabled={isSavingProxyPayment}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 text-sm font-black text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isSavingProxyPayment ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  내역 추가
                </button>
              </div>
              {proxyPaymentMessage && (
                <p className="mt-3 text-sm font-bold text-slate-600">{proxyPaymentMessage}</p>
              )}
            </form>

            {proxyPayments.length === 0 ? (
              <p className="py-8 text-center text-sm font-semibold text-slate-400">등록된 결제 내역이 없습니다.</p>
            ) : (
              <div className="relative overflow-x-auto pt-2">
                <table className="w-full min-w-[780px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-black text-slate-500">
                      <th className="px-2 py-3">결제일</th>
                      <th className="px-2 py-3">업체</th>
                      <th className="px-2 py-3 text-right">최종 결제액</th>
                      <th className="px-2 py-3 text-center">VAT</th>
                      <th className="px-2 py-3">사용기간</th>
                      <th className="px-2 py-3">메모</th>
                      <th className="w-10 px-2 py-3"><span className="sr-only">삭제</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxyPayments.map((payment) => (
                      <tr key={payment.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="whitespace-nowrap px-2 py-3 font-bold text-slate-700">{formatDate(payment.paidOn)}</td>
                        <td className="whitespace-nowrap px-2 py-3 font-black text-slate-900">{payment.provider}</td>
                        <td className="whitespace-nowrap px-2 py-3 text-right font-black text-slate-950">
                          {formatProxyPaymentAmount(payment.amountMinor, payment.currency)}
                        </td>
                        <td className="px-2 py-3 text-center">
                          <span className={cn(
                            "inline-flex rounded-full px-2 py-1 text-[11px] font-black",
                            payment.vatIncluded ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500",
                          )}>
                            {payment.vatIncluded ? "포함" : "별도"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 font-semibold text-slate-600">
                          {payment.periodStart && payment.periodEnd
                            ? `${formatDate(payment.periodStart)} ~ ${formatDate(payment.periodEnd)}`
                            : payment.periodStart
                              ? `${formatDate(payment.periodStart)}부터`
                              : "-"}
                        </td>
                        <td className="max-w-64 truncate px-2 py-3 font-semibold text-slate-500" title={payment.note || undefined}>
                          {payment.note || "-"}
                        </td>
                        <td className="px-2 py-3 text-right">
                          <button
                            type="button"
                            title="결제 내역 삭제"
                            onClick={() => void deleteProxyPayment(payment)}
                            disabled={deletingProxyPaymentId === payment.id}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                          >
                            {deletingProxyPaymentId === payment.id
                              ? <RefreshCw className="h-4 w-4 animate-spin" />
                              : <Trash2 className="h-4 w-4" />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-black text-slate-900">자동화 기준</h2>
            <div className="mt-4 grid gap-3 text-sm font-semibold text-slate-600 md:grid-cols-2">
              <p className="rounded-lg bg-slate-50 px-3 py-3">네이버 예약 확정: 상세정보 확인 후 슬롯 차단</p>
              <p className="rounded-lg bg-slate-50 px-3 py-3">네이버 예약 취소: 취소 처리 후 슬롯 오픈</p>
              <p className="rounded-lg bg-slate-50 px-3 py-3">스클 예약 확정: 상세정보 확인 후 네이버 슬롯 차단</p>
              <p className="rounded-lg bg-slate-50 px-3 py-3">스클 예약 취소: 호스트센터에서 수수료 확인 후 네이버 슬롯 오픈</p>
              <p className="rounded-lg bg-slate-50 px-3 py-3">실패/불확실 상태: 조작 중단 후 확인필요 알림</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
