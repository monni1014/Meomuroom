"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type AlertItem = {
  id: string;
  title: string;
  message: string;
};

export default function DismissibleAdminAlerts({ alerts: initialAlerts }: { alerts: AlertItem[] }) {
  const [hiddenAlertIds, setHiddenAlertIds] = useState<string[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
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

  if (alerts.length === 0) return null;

  return (
    <section className="space-y-2">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="relative flex gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 pr-11 text-rose-950"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
          <div className="min-w-0">
            <p className="text-sm font-black">{alert.title}</p>
            <p className="mt-1 text-xs font-semibold text-rose-800">{alert.message}</p>
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
