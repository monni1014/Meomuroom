"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type AlertItem = {
  id: string;
  title: string;
  message: string;
  type: string;
  candidateId: string | null;
};

export default function DismissibleAdminAlerts({ alerts: initialAlerts }: { alerts: AlertItem[] }) {
  const [hiddenAlertIds, setHiddenAlertIds] = useState<string[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const alerts = initialAlerts.filter((alert) => !hiddenAlertIds.includes(alert.id));

  async function dismissAlert(alert: AlertItem) {
    if (dismissingId) return;
    setDismissingId(alert.id);
    setHiddenAlertIds((current) => [...current, alert.id]);

    try {
      const response = await fetch(`/api/admin-alerts/${alert.id}`, { method: "PATCH" });
      if (!response.ok) throw new Error("Failed to dismiss alert");
    } catch (error) {
      console.error(error);
      setHiddenAlertIds((current) => current.filter((id) => id !== alert.id));
    } finally {
      setDismissingId(null);
    }
  }

  async function decideFakeBlock(alert: AlertItem, action: "confirm" | "dismiss") {
    if (!alert.candidateId || decidingId) return;
    setDecidingId(alert.id);

    try {
      const response = await fetch(`/api/fake-block-candidates/${alert.candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("Failed to update fake block candidate");
      setHiddenAlertIds((current) => [...current, alert.id]);
    } catch (error) {
      console.error(error);
      window.alert("뻥카 확인 결과를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setDecidingId(null);
    }
  }

  if (alerts.length === 0) return null;

  return (
    <section className="space-y-2">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="relative flex gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 pr-11 text-rose-950"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black">{alert.title}</p>
            <p className="mt-1 text-xs font-semibold text-rose-800">{alert.message}</p>
            {alert.type === "FAKE_BLOCK_CANDIDATE" && alert.candidateId ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void decideFakeBlock(alert, "confirm")}
                  disabled={decidingId === alert.id}
                  className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-black text-white transition-colors hover:bg-rose-800 disabled:opacity-50"
                >
                  뻥카 맞음 · 월간표 반영
                </button>
                <button
                  type="button"
                  onClick={() => void decideFakeBlock(alert, "dismiss")}
                  disabled={decidingId === alert.id}
                  className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-black text-rose-800 transition-colors hover:bg-rose-100 disabled:opacity-50"
                >
                  뻥카 아님
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void dismissAlert(alert)}
            disabled={dismissingId === alert.id}
            className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center text-rose-500 transition-colors hover:text-rose-900 disabled:opacity-40"
            aria-label={`${alert.title} 경고 닫기`}
            title="경고 닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </section>
  );
}
