"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  MessageSquareText,
  Phone,
  RefreshCw,
  Save,
  ServerCog,
  WalletCards,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SolapiServiceStatus } from "@/lib/solapi-status";

type MessageTemplateState = {
  id: string;
  roomName: string;
  title: string;
  content: string;
  updatedAt: string;
};

type ProxyStatus = {
  configured: boolean;
  availableGb: number | null;
  warningGb: number;
  criticalGb: number;
  severity: "OK" | "WARNING" | "CRITICAL" | "UNKNOWN";
  checkedAt: string | null;
  alertTitle: string | null;
};

type SettingsTab = "message" | "rpa";

function formatWon(value: number | null) {
  if (value === null) return "-";
  return `${Math.round(value).toLocaleString()}원`;
}

function formatGb(value: number | null) {
  if (value === null) return "-";
  return `${value.toFixed(2)}GB`;
}

function formatPhone(value: string | null) {
  if (!value) return "-";
  if (value.length === 11) return `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7)}`;
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

function proxyStatusClass(status: ProxyStatus) {
  if (!status.configured || status.severity === "UNKNOWN") return "border-slate-200 bg-slate-50 text-slate-600";
  if (status.severity === "CRITICAL") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status.severity === "WARNING") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function proxyStatusLabel(status: ProxyStatus) {
  if (!status.configured) return "API 토큰 필요";
  if (status.availableGb === null) return "확인필요";
  if (status.severity === "CRITICAL") return "매우 부족";
  if (status.severity === "WARNING") return "부족";
  return "정상";
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
}: {
  initialSolapiStatus: SolapiServiceStatus;
  initialMessageTemplates: MessageTemplateState[];
  initialProxyStatus: ProxyStatus;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("message");
  const [solapiStatus, setSolapiStatus] = useState<SolapiServiceStatus>(initialSolapiStatus);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>(initialProxyStatus);
  const [templates, setTemplates] = useState<MessageTemplateState[]>(initialMessageTemplates);
  const [isLoadingSolapi, setIsLoadingSolapi] = useState(false);
  const [isLoadingProxy, setIsLoadingProxy] = useState(false);
  const [savingRoom, setSavingRoom] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadSolapiStatus = useCallback(async () => {
    setIsLoadingSolapi(true);
    try {
      const response = await fetch("/api/settings/solapi/status", { cache: "no-store" });
      const data = (await response.json()) as SolapiServiceStatus;
      setSolapiStatus(data);
    } finally {
      setIsLoadingSolapi(false);
    }
  }, []);

  const loadProxyStatus = useCallback(async () => {
    setIsLoadingProxy(true);
    try {
      const response = await fetch("/api/proxy-traffic/status", { cache: "no-store" });
      const data = (await response.json()) as ProxyStatus;
      setProxyStatus(data);
    } finally {
      setIsLoadingProxy(false);
    }
  }, []);

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

  const sender = solapiStatus.sender ?? null;
  const senderStatus = senderStatusLabel(sender?.status ?? null);
  const renewalText = sender?.expireAt
    ? formatDateTime(sender.expireAt)
    : sender?.autoExtension ? "자동연장" : "-";

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
                  <p className="text-sm font-bold text-slate-500">프록시 잔여량</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                    {formatGb(proxyStatus.availableGb)}
                  </p>
                </div>
                <div className="rounded-full bg-sky-50 p-3 text-sky-600">
                  <Wifi className="h-6 w-6" />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex rounded-full border px-3 py-1 text-xs font-black", proxyStatusClass(proxyStatus))}>
                  {proxyStatusLabel(proxyStatus)}
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
                <InfoRow label="IPRoyal 설정" value={proxyStatus.configured ? "설정됨" : "API 토큰 필요"} />
                <InfoRow label="최근 확인" value={formatDateTime(proxyStatus.checkedAt)} />
                <InfoRow label="주의 기준" value={formatGb(proxyStatus.warningGb)} />
                <InfoRow label="위험 기준" value={formatGb(proxyStatus.criticalGb)} />
                <InfoRow label="메일 확인 주기" value="30초" />
                <InfoRow label="프록시 확인 주기" value="10분" />
              </div>
              {proxyStatus.alertTitle && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                  현재 알림: {proxyStatus.alertTitle}
                </div>
              )}
            </div>
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
