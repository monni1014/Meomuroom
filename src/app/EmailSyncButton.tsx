"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

export default function EmailSyncButton() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSync = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/email-sync");
      const data = await res.json();
      if (data.success) {
        setMessage(`✅ ${data.message}`);
        // Reload page to refresh server component data
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setMessage(`❌ ${data.error}`);
      }
    } catch {
      setMessage("❌ 메일 서버 연결 실패");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setMessage(null), 5000);
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <button
        onClick={handleSync}
        disabled={isSyncing}
        className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-xs font-bold text-white shadow-md shadow-emerald-100 transition-all active:scale-95 sm:gap-2 sm:rounded-xl sm:px-4 sm:py-2.5 sm:text-sm ${
          isSyncing ? "bg-slate-400 cursor-wait" : "bg-emerald-600 hover:bg-emerald-700"
        }`}
      >
        <RefreshCw className={`h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4 ${isSyncing ? "animate-spin" : ""}`} />
        {isSyncing ? "동기화 중..." : "메일 동기화"}
      </button>
      {message && (
        <span className={`text-xs font-medium px-3 py-1.5 rounded-lg ${
          message.startsWith("✅") ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
        }`}>
          {message}
        </span>
      )}
    </div>
  );
}
