"use client";

import { useEffect, useState } from "react";
import { Bell, BellRing, LoaderCircle } from "lucide-react";

type PushConfig = {
  configured: boolean;
  publicKey: string | null;
};

const SERVICE_WORKER_URL = "/sw.js?v=20260723-4";
const SERVICE_WORKER_OPTIONS: RegistrationOptions = {
  scope: "/",
  updateViaCache: "none",
};

function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

export default function PushNotificationSetup() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [supported, setSupported] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const browserSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!browserSupported) {
        setSupported(false);
        return;
      }
      try {
        const response = await fetch("/api/push/config", { cache: "no-store" });
        const payload = await response.json() as PushConfig;
        if (disposed) return;
        setConfig(payload);
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, SERVICE_WORKER_OPTIONS);
        await registration.update();
        const existing = await registration.pushManager.getSubscription();
        if (!disposed) setSubscribed(Boolean(existing));
      } catch {
        if (!disposed) setMessage("알림 상태를 확인하지 못했습니다.");
      }
    };
    void load();
    return () => { disposed = true; };
  }, []);

  const enable = async () => {
    if (!config?.publicKey) return;
    setBusy(true);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("알림 권한이 허용되지 않았습니다. 휴대폰 설정에서 머무룸 알림을 허용해주세요.");
        return;
      }
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, SERVICE_WORKER_OPTIONS);
      await registration.update();
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(config.publicKey),
      });
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error("subscription save failed");
      setSubscribed(true);
      setMessage("이 기기에서 문자·RPA 장애 알림을 받습니다.");
    } catch (error) {
      console.error("Push subscription error:", error);
      setMessage("알림 연결에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        이 브라우저는 앱 알림을 지원하지 않습니다. 아이폰은 Safari에서 머무룸을 ‘홈 화면에 추가’한 뒤 그 아이콘으로 열어주세요.
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        <LoaderCircle className="h-4 w-4 animate-spin" /> 알림 상태 확인 중
      </div>
    );
  }

  if (!config.configured) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        휴대폰 알림 서버 설정을 준비 중입니다.
      </div>
    );
  }

  const iphoneInstallHint = /iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalone();

  return (
    <div className={`rounded-2xl border p-4 ${subscribed ? "border-emerald-200 bg-emerald-50" : "border-indigo-200 bg-indigo-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {subscribed ? <BellRing className="h-5 w-5 text-emerald-600" /> : <Bell className="h-5 w-5 text-indigo-600" />}
          <div>
            <p className="text-sm font-extrabold text-slate-900">
              {subscribed ? "장애 알림 켜짐" : "문자·RPA 장애를 휴대폰으로 알림"}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              {subscribed ? "문자 수신 실패와 RPA·로그인 장애만 알려드립니다." : "정상 완료 알림은 보내지 않습니다."}
            </p>
          </div>
        </div>
        {!subscribed && !iphoneInstallHint && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm disabled:opacity-60"
          >
            {busy ? "연결 중…" : "알림 켜기"}
          </button>
        )}
      </div>
      {iphoneInstallHint && (
        <p className="mt-3 rounded-xl bg-white/80 p-3 text-xs font-semibold leading-5 text-indigo-800">
          아이폰 Safari의 공유 버튼 → ‘홈 화면에 추가’ → 새 머무룸 아이콘으로 연 뒤 알림을 켜주세요.
        </p>
      )}
      {message && <p className="mt-3 text-xs font-semibold text-slate-700">{message}</p>}
    </div>
  );
}
