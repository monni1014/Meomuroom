"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UNCATEGORIZED_LABEL } from "@/lib/categories";
import { ChevronDown, ChevronUp } from "lucide-react";
import RpaStatusBadge from "@/components/RpaStatusBadge";

interface MonthlyReservation {
  id: string;
  source: string;
  roomName: string;
  customerName: string | null;
  startTime: Date | string;
  endTime: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  status: string;
  price: number;
  discount: number;
  emailId: string | null;
  paymentMethod: string | null;
  isPaid: boolean;
  memo: string | null;
  usageLog: {
    headCount: number;
    purpose: string | null;
    detail: string | null;
  } | null;
}

export default function MonthlyReservationsList({ reservations }: { reservations: MonthlyReservation[] }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  
  const now = new Date();
  const validReservations = reservations.filter((reservation) => reservation.status !== "CANCELLED");
  const upcoming = validReservations
    .filter((reservation) => new Date(reservation.endTime) >= now)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const passed = validReservations
    .filter((reservation) => new Date(reservation.endTime) < now)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const displayList = [...upcoming, ...passed];

  const getSourceDisplay = (source: string) => {
    switch(source) {
      case "naver": return "네이버";
      case "spacecloud": return "스페이스클라우드";
      case "direct": return "직접";
      default: return "직접";
    }
  };

  const formatTimeRange = (start: Date, end: Date) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const m = `${start.getMonth() + 1}/${start.getDate()}`;
    const startStr = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    const endStr = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
    return `[${m}] ${startStr} - ${endStr}`;
  };

  if (displayList.length === 0) {
    return (
      <div className="lg:col-span-2 text-center py-8 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-sm">
        이 달에 유효한 예약 일정이 없습니다.<br />
      </div>
    );
  }

  // Show only 6 by default
  const INITIAL_COUNT = 6;
  const visibleList = showAll ? displayList : displayList.slice(0, INITIAL_COUNT);
  const hasMore = displayList.length > INITIAL_COUNT;

  return (
    <div className="lg:col-span-2 space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {visibleList.map((res) => {
          const isPassed = new Date(res.endTime) < now;
          const borderColors = isPassed
            ? "border-l-slate-300 opacity-60"
            : res.source === "naver" ? "border-l-green-500" :
              res.source === "spacecloud" ? "border-l-indigo-500" : "border-l-amber-500";
          const labelColors =
            res.source === "naver" ? "bg-green-50 text-green-700" :
            res.source === "spacecloud" ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700";
          const roomColors =
            res.roomName === "머무룸1" ? "bg-sky-50 text-sky-700" :
              res.roomName === "머무룸2" ? "bg-purple-50 text-purple-700" :
                res.roomName === "머무룸3" ? "bg-orange-50 text-orange-700" : "bg-slate-100 text-slate-700";

          return (
            <div
              key={res.id}
              onDoubleClick={() => {
                // 더블클릭 시 캘린더 탭으로 이동하며 해당 날짜를 보여줍니다
                const dateStr = new Date(res.startTime).toISOString().split('T')[0];
                router.push(`/calendar?date=${dateStr}`);
              }}
              title="더블클릭하면 캘린더로 이동합니다"
              className={`p-4 rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] border flex justify-between items-center border-l-4 ${borderColors} bg-white cursor-pointer select-none`}
            >
              <div>
                <p className={`text-sm font-semibold ${isPassed ? "text-slate-400" : "text-slate-900"}`}>
                  {formatTimeRange(new Date(res.startTime), new Date(res.endTime))}
                </p>
                <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1.5 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${labelColors}`}>
                    {getSourceDisplay(res.source)}
                  </span>
                  {!res.emailId && res.paymentMethod !== '온라인' && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700">
                      ✍️수기
                    </span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${roomColors}`}>
                    {res.roomName}
                  </span>
                  <strong className={isPassed ? "text-slate-500" : "text-slate-800"}>{res.customerName}</strong>
                  {!res.isPaid && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-600">
                      💸 미결제
                    </span>
                  )}
                <RpaStatusBadge memo={res.memo} createdAt={res.createdAt} updatedAt={res.updatedAt} />
                <span>· {res.usageLog?.headCount || 0}명 ({res.usageLog?.purpose || UNCATEGORIZED_LABEL}{res.usageLog?.detail ? ` · ${res.usageLog.detail}` : ""})</span>
                  {res.price > 0 && (
                    <span className="font-medium">
                      · {res.price.toLocaleString()}원
                    </span>
                  )}
                  {res.discount > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-600">
                      🎟️ 쿠폰 -{res.discount.toLocaleString()}원
                    </span>
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full mt-4 py-3 bg-slate-50 hover:bg-slate-100 text-slate-600 font-semibold text-sm rounded-xl border border-slate-200 transition flex items-center justify-center gap-1"
        >
          {showAll ? "접기" : `더보기 (${displayList.length - INITIAL_COUNT}개)`}
          {showAll ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
