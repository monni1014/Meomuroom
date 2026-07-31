"use client";

import { useRouter } from "next/navigation";
import { UNCATEGORIZED_LABEL } from "@/lib/categories";
import RpaStatusBadge from "@/components/RpaStatusBadge";
import { getKstDateKey, getKstDateParts } from "@/lib/kst-time";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function TodayReservationsList({ events }: { events: any[] }) {
  const router = useRouter();

  const getSourceDisplay = (source: string) => {
    switch (source) {
      case "naver": return "네이버";
      case "spacecloud": return "스페이스클라우드";
      case "direct": return "직접";
      default: return "직접";
    }
  };

  const formatTimeRange = (start: Date, end: Date) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const startParts = getKstDateParts(start);
    const endParts = getKstDateParts(end);
    const m = `${startParts.month}/${startParts.day}`;
    const startStr = `${pad(startParts.hour)}:${pad(startParts.minute)}`;
    const endStr = `${pad(endParts.hour)}:${pad(endParts.minute)}`;
    return `[${m}] ${startStr} - ${endStr}`;
  };

  if (events.length === 0) {
    return (
      <div className="lg:col-span-2 text-center py-8 bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 text-sm">
        오늘 접수·취소·변경된 일정이 없습니다.<br />
      </div>
    );
  }

  return (
    <>
      {events.map((res) => {
        if (res.dashboardItemType === "CALENDAR_SCHEDULE") {
          const isSiteVisit = res.scheduleType === "SITE_VISIT";
          const isUpdatedToday = res.dashboardEventType === "UPDATED_TODAY";
          const scheduleLabel = `${isSiteVisit ? "사전답사" : "청소"} ${isUpdatedToday ? "변경" : "등록"}`;
          const roomColors: Record<string, string> = {
            "머무룸1": "bg-sky-50 text-sky-700",
            "머무룸2": "bg-purple-50 text-purple-700",
            "머무룸3": "bg-orange-50 text-orange-700",
          };

          return (
            <div
              key={`calendar-schedule-${res.id}`}
              onDoubleClick={() => {
                const dateStr = getKstDateKey(new Date(res.startTime));
                router.push(`/calendar?date=${dateStr}&focus=agenda`);
              }}
              title="더블클릭하면 해당 날짜의 일정 상세 목록으로 이동합니다"
              className={`cursor-pointer select-none rounded-xl border border-l-4 p-4 shadow-[0_2px_8px_rgba(0,0,0,0.02)] ${
                isSiteVisit
                  ? "border-cyan-100 border-l-cyan-400 bg-cyan-50/50"
                  : "border-amber-100 border-l-amber-400 bg-amber-50/50"
              }`}
            >
              <p className="text-sm font-semibold text-slate-900">
                {formatTimeRange(new Date(res.startTime), new Date(res.endTime))}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  isSiteVisit ? "bg-cyan-100 text-cyan-800" : "bg-amber-100 text-amber-800"
                }`}>
                  {isSiteVisit ? "🔭" : "🧹"} {scheduleLabel}
                </span>
                {res.roomNames.map((roomName: string) => (
                  <span
                    key={roomName}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${roomColors[roomName] || "bg-slate-100 text-slate-700"}`}
                  >
                    {roomName}
                  </span>
                ))}
                <strong className="text-slate-800">{res.cleanerName}</strong>
                {isSiteVisit && (
                  <span>{res.source === "spacecloud" ? "스클" : "네이버"}</span>
                )}
                {!isSiteVisit && res.cost > 0 && (
                  <span>· 비용 {res.cost.toLocaleString()}원 · {res.isPaid ? "입금 완료" : "미입금"}</span>
                )}
              </p>
            </div>
          );
        }

        const isCancelled = res.status === "CANCELLED";
        const isCancelledToday = res.dashboardEventType === "CANCELLED_TODAY";
        const borderColors = isCancelled
          ? "border-l-slate-300"
          : res.source === "naver" ? "border-l-green-500" :
            res.source === "spacecloud" ? "border-l-indigo-500" : "border-l-amber-500";
        const labelColors =
          res.source === "naver" ? "bg-green-50 hover:bg-green-100 text-green-700" :
            res.source === "spacecloud" ? "bg-indigo-50 hover:bg-indigo-100 text-indigo-700" : "bg-amber-50 hover:bg-amber-100 text-amber-700";
        const roomColors =
          res.roomName === "머무룸1" ? "bg-sky-50 text-sky-700" :
            res.roomName === "머무룸2" ? "bg-purple-50 text-purple-700" :
              res.roomName === "머무룸3" ? "bg-orange-50 text-orange-700" : "bg-slate-100 text-slate-700";

        return (
          <div
            key={res.id}
            onDoubleClick={() => {
              const dateStr = getKstDateKey(new Date(res.startTime));
              router.push(`/calendar?date=${dateStr}&focus=agenda`);
            }}
            title="더블클릭하면 해당 날짜의 예약 상세 목록으로 이동합니다"
            className={`p-4 rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] border flex justify-between items-center border-l-4 ${borderColors} ${isCancelled ? "bg-slate-100 border-slate-200" : "bg-white border-slate-100"} cursor-pointer select-none`}
          >
            <div>
              <p className={`text-sm font-semibold ${isCancelled ? "text-slate-400 line-through" : "text-slate-900"}`}>
                {formatTimeRange(new Date(res.startTime), new Date(res.endTime))}
              </p>
              <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1.5 flex-wrap">
                {isCancelled && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-600">
                    🚫 {isCancelledToday ? "오늘 취소" : "취소됨"}
                  </span>
                )}
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${labelColors}`}>
                  {getSourceDisplay(res.source)}
                </span>
                {!res.emailId && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700">
                    ✍️수기
                  </span>
                )}
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${roomColors}`}>
                  {res.roomName}
                </span>
                <strong className={isCancelled ? "text-slate-500" : "text-slate-800"}>{res.customerName}</strong>
                {!isCancelled && !res.isPaid && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-600">
                    💸 미결제
                  </span>
                )}
                  <RpaStatusBadge memo={res.memo} createdAt={res.createdAt} updatedAt={res.updatedAt} />
                  <span>· {res.usageLog?.headCount || 0}명 ({res.usageLog?.purpose || UNCATEGORIZED_LABEL}{res.usageLog?.detail ? ` · ${res.usageLog.detail}` : ""})</span>
                {res.price > 0 && (
                  <span className={`font-medium ${isCancelled ? "text-slate-500" : "text-emerald-600"}`}>
                    · {res.price.toLocaleString()}원{isCancelled ? " (수수료)" : ""}
                  </span>
                )}
                {!isCancelled && res.discount > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-600">
                    🎟️ 쿠폰 -{res.discount.toLocaleString()}원
                  </span>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </>
  );
}
