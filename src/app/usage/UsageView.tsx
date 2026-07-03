"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Search, Users, Coffee, Tag, AlertCircle, Pencil, ChevronDown, Wallet, Clock } from "lucide-react";
import { MAJOR_CATEGORIES, SUB_CATEGORIES, UNCATEGORIZED_LABEL } from "@/lib/categories";
import TimeSelect from "@/components/TimeSelect";
import RpaStatusBadge from "@/components/RpaStatusBadge";

interface UsageLog {
  id: string;
  headCount: number;          // 실제 이용인원
  reservedHeadCount: number;  // 예약 이용인원
  coffeeCount: number;
  purpose: string | null;
  detail: string | null;
  extraTime: number;
  extraPrice: number | null;
  isExtraPaid: boolean;
  extraPaymentMethod: string | null;
}

interface Reservation {
  id: string;
  source: string;
  roomName: string;
  customerName: string | null;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
  price: number;
  discount: number;
  status: string;
  isNoShow: boolean;
  paymentMethod: string | null;
  memo: string | null;
  complaints: string | null;
  emailId: string | null; // null = 수기 입력
  isPaid: boolean;
  isCleanUpBad: boolean;
  usageLog: UsageLog | null;
}

export default function UsagePage() {
  const router = useRouter();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [selectedResId, setSelectedResId] = useState<string>("");
  const [isSelectOpen, setIsSelectOpen] = useState(false); // 대상선택 커스텀 드롭다운 열림
  const [headCount, setHeadCount] = useState(0); // 실제 이용인원
  const [reserved, setReserved] = useState(0);   // 예약 이용인원 (읽기전용)
  const [coffeeCount, setCoffeeCount] = useState(0);
  const [selectedPurpose, setSelectedPurpose] = useState(""); // 대분류 ("" = 미선택)
  const [detail, setDetail] = useState(""); // 세부내용 자유입력
  const [editDate, setEditDate] = useState("");   // 이용 날짜 (수정)
  const [editStart, setEditStart] = useState(""); // 시작 시간 (수정)
  const [editEnd, setEditEnd] = useState("");     // 종료 시간 (수정)
  const [editRoomName, setEditRoomName] = useState(""); // 공간명 (수정)
  const [currentPrice, setCurrentPrice] = useState(0); // 현재 표시/수정될 결제 금액
  const [memo, setMemo] = useState(""); // 관리자 비고란
  const [complaints, setComplaints] = useState(""); // 고객 불만사항
  const [isPaid, setIsPaid] = useState(true); // 결제여부
  const [isCleanUpBad, setIsCleanUpBad] = useState(false); // 정리불량
  const [isExtraPaid, setIsExtraPaid] = useState(false); // 추가 금액 결제 여부
  const [extraPaymentMethod, setExtraPaymentMethod] = useState<string>("계좌이체"); // 추가 금액 결제 수단
  const [extraTime, setExtraTime] = useState(0); // 추가된 시간 (시간 단위)
  const [originalPrice, setOriginalPrice] = useState(0); // 수동 수정 가능한 원래 금액
  const [extraPrice, setExtraPrice] = useState(0); // 수동 수정 가능한 추가 발생 금액
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const fetchReservations = async (preserveId?: string) => {
    try {
      const res = await fetch("/api/reservations");
      if (res.ok) {
        const data: Reservation[] = await res.json();
        setReservations(data);

        // 저장 후에는 현재 선택을 유지하고 싶을 때
        if (preserveId && data.some(r => r.id === preserveId)) {
          return;
        }

        // Find a reservation in progress or closest upcoming, set as initial choice
        if (data.length > 0) {
          // 캘린더에서 더블클릭으로 넘어온 경우 ?selected=<id> 예약을 우선 선택
          const preselectId = typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("selected")
            : null;
          const preselected = preselectId ? data.find((r) => r.id === preselectId) : null;

          const now = new Date();
          const inProgress = data.find((r) => {
            const start = new Date(r.startTime);
            const end = new Date(r.endTime);
            return now >= start && now <= end;
          });

          const defaultRes = preselected || inProgress || data[0];
          setSelectedResId(defaultRes.id);
          setHeadCount(defaultRes.usageLog?.headCount || 2);
          setReserved(defaultRes.usageLog?.reservedHeadCount ?? defaultRes.usageLog?.headCount ?? 0);
          setCoffeeCount(defaultRes.usageLog?.coffeeCount || 0);
          setSelectedPurpose(defaultRes.usageLog?.purpose || "");
          setDetail(defaultRes.usageLog?.detail || "");
          setEditDate(toDateInput(defaultRes.startTime));
          setEditStart(toTimeInput(defaultRes.startTime));
          setEditEnd(toTimeInput(defaultRes.endTime));
          setEditRoomName(defaultRes.roomName || "머무룸1");
          setMemo(defaultRes.memo || "");
          setComplaints(defaultRes.complaints || "");
          setIsPaid(defaultRes.isPaid ?? true);
          setIsCleanUpBad(defaultRes.isCleanUpBad ?? false);
          setIsExtraPaid(defaultRes.usageLog?.isExtraPaid ?? false);
          setExtraPaymentMethod(defaultRes.usageLog?.extraPaymentMethod || "계좌이체");
          setExtraTime(defaultRes.usageLog?.extraTime || 0);

          // 초기 추가 금액 계산 로직
          const savedExtra = defaultRes.usageLog?.extraPrice;
          
          let initialRate = 0;
          const sDate = new Date(defaultRes.startTime);
          if (defaultRes.source === "naver") {
            const isWeekend = sDate.getDay() === 0 || sDate.getDay() === 6;
            initialRate = isWeekend ? 2500 : 2000;
          } else if (defaultRes.source === "spacecloud") {
            const isWeekend = sDate.getDay() === 0 || sDate.getDay() === 6;
            const holidays = ["01-01", "02-16", "02-17", "02-18", "03-01", "03-02", "05-05", "05-24", "05-25", "06-06", "08-15", "09-24", "09-25", "09-26", "10-03", "10-09", "12-25"];
            const isHoliday = holidays.includes(defaultRes.startTime.substring(5, 10));
            initialRate = (isWeekend || isHoliday) ? 3000 : 2500;
          }
          const eDate = new Date(defaultRes.endTime);
          let durationHours = (eDate.getTime() - sDate.getTime()) / (1000 * 60 * 60);
          if (durationHours <= 0) durationHours = 1;
          const extraPeople = Math.max(0, (defaultRes.usageLog?.headCount || 2) - (defaultRes.usageLog?.reservedHeadCount ?? defaultRes.usageLog?.headCount ?? 0));
          
          let calculatedExtra = 0;
          if (savedExtra != null) {
            calculatedExtra = savedExtra;
          } else {
            calculatedExtra = extraPeople * initialRate * durationHours;
          }
          const totalPrice = defaultRes.price || 0;
          const basePrice = Math.max(0, totalPrice - calculatedExtra);
          setExtraPrice(calculatedExtra);
          setOriginalPrice(basePrice);
          setCurrentPrice(totalPrice);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReservations();
  }, []);

  const handleSelectionChange = (resId: string) => {
    setSelectedResId(resId);
    const found = reservations.find((r) => r.id === resId);
    if (found) {
      let initialRate = 0;
      const sDate = new Date(found.startTime);
      if (found.source === "naver") {
        const isWeekend = sDate.getDay() === 0 || sDate.getDay() === 6;
        initialRate = isWeekend ? 2500 : 2000;
      } else if (found.source === "spacecloud") {
        const isWeekend = sDate.getDay() === 0 || sDate.getDay() === 6;
        const holidays = ["01-01", "02-16", "02-17", "02-18", "03-01", "03-02", "05-05", "05-24", "05-25", "06-06", "08-15", "09-24", "09-25", "09-26", "10-03", "10-09", "12-25"];
        const isHoliday = holidays.includes(found.startTime.substring(5, 10));
        initialRate = (isWeekend || isHoliday) ? 3000 : 2500;
      } else {
        initialRate = 2000;
      }

      const eDate = new Date(found.endTime);
      let durationHours = (eDate.getTime() - sDate.getTime()) / (1000 * 60 * 60);
      if (durationHours <= 0) durationHours = 1;

      // 예약 인원 역산 (UsageLog가 없을 때)
      let calculatedReservedHeadCount = 0;
      if (found.usageLog?.reservedHeadCount) {
        calculatedReservedHeadCount = found.usageLog.reservedHeadCount;
      } else {
        if (initialRate > 0) {
          calculatedReservedHeadCount = Math.round(((found.price || 0) + (found.discount || 0)) / (initialRate * durationHours));
        }
        if (calculatedReservedHeadCount <= 0 || !isFinite(calculatedReservedHeadCount)) calculatedReservedHeadCount = 2; // fallback
      }

      setReserved(calculatedReservedHeadCount);
      setHeadCount(found.usageLog?.headCount ?? calculatedReservedHeadCount);
      setCoffeeCount(found.usageLog?.coffeeCount || 0);
      setSelectedPurpose(found.usageLog?.purpose || "");
      setDetail(found.usageLog?.detail || "");
      setEditDate(toDateInput(found.startTime));
      setEditStart(toTimeInput(found.startTime));
      setEditEnd(toTimeInput(found.endTime));
      setEditRoomName(found.roomName || "머무룸1");
      setMemo(found.memo || "");
      setComplaints(found.complaints || "");
      setIsPaid(found.isPaid ?? true);
      setIsCleanUpBad(found.isCleanUpBad ?? false);
      setIsExtraPaid(found.usageLog?.isExtraPaid ?? false);
      setExtraPaymentMethod(found.usageLog?.extraPaymentMethod || "계좌이체");
      setExtraTime(found.usageLog?.extraTime || 0);

      // 초기 추가 금액 계산
      const savedExtra = found.usageLog?.extraPrice;
      let calculatedExtra = 0;
      if (savedExtra != null) {
        calculatedExtra = savedExtra;
      } else {
        // UsageLog가 없으면 확정된 추가금이 없으므로 0
        calculatedExtra = 0;
      }
      const totalPrice = found.price || 0;
      const basePrice = Math.max(0, totalPrice - calculatedExtra);
      setExtraPrice(calculatedExtra);
      setOriginalPrice(basePrice);
      setCurrentPrice(totalPrice);
    }
  };

  // 추가금은 자동계산하지 않는다(수동 입력). 시간이 바뀌면 "추가시간(기록)"만 갱신한다.
  // 연장 시 인원이 달라지는 경우가 많아 공식으로 추가금을 못 맞추므로, 금액은 사장님이 직접 입력.
  const recalcExtraTime = (newStart: string, newEnd: string) => {
    if (!selectedResId) return;
    const found = reservations.find((r) => r.id === selectedResId);
    if (!found) return;

    // 예약 기준 시간 (DB 원본에서 기존 추가시간 빼서 원래 예약시간 산출)
    const origStart = new Date(found.startTime);
    const origEnd = new Date(found.endTime);
    const dbDuration = (origEnd.getTime() - origStart.getTime()) / (1000 * 60 * 60);
    let reservedHours = dbDuration - (found.usageLog?.extraTime || 0);
    if (reservedHours <= 0) reservedHours = 1;

    // 변경된 실제 사용 시간 (분 단위 계산, 26시 같은 값 안전 처리)
    const hmToMin = (t: string) => { const [h, m] = (t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const sMin = hmToMin(newStart);
    let eMin = hmToMin(newEnd);
    if (eMin <= sMin) eMin += 24 * 60;
    const newDurationHours = (eMin - sMin) / 60;

    const extra = newDurationHours - reservedHours;
    setExtraTime(extra > 0 ? extra : 0); // 시간 기록용 (금액엔 영향 없음)
  };

  const handleHeadCountChange = (newCount: number) => {
    if (newCount < 0) return;
    setHeadCount(newCount); // 실제 인원 기록만 (금액 영향 없음)
  };

  const handleStartTimeChange = (newStart: string) => {
    setEditStart(newStart);
    recalcExtraTime(newStart, editEnd);
  };

  const handleEndTimeChange = (newEnd: string) => {
    setEditEnd(newEnd);
    recalcExtraTime(editStart, newEnd);
  };

  const addExtraTime = (hours: number) => {
    if (!editEnd) return;
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const [h, m] = editEnd.split(":").map(Number);
    let eMin = (h || 0) * 60 + (m || 0) + hours * 60;
    if (eMin > 26 * 60) eMin = 26 * 60; // 최대 26시까지
    const newEnd = `${pad2(Math.floor(eMin / 60))}:${pad2(eMin % 60)}`;
    handleEndTimeChange(newEnd);
  };

  // 수동 취소/노쇼 (기록 남기고 수수료를 매출로 반영. 매출·집계는 동일, 표기만 구분)
  const handleCancelReservation = async (isNoShow: boolean) => {
    if (!selectedResId) return;
    const label = isNoShow ? "노쇼" : "취소";
    const feeStr = prompt(
      `${label} 처리합니다.\n${label} 수수료(매출로 잡힐 금액)를 입력하세요.\n· 수수료 없음 → 0\n· 전액(100%) → ${currentPrice.toLocaleString()}원`,
      String(currentPrice)
    );
    if (feeStr === null) return;
    const fee = parseInt(feeStr.replace(/[^\d]/g, ""), 10);
    if (isNaN(fee)) { alert("숫자를 입력해 주세요."); return; }

    try {
      const res = await fetch(`/api/reservations/${selectedResId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", price: fee, isNoShow }),
      });
      if (res.ok) fetchReservations(selectedResId);
      else alert(`${label} 처리에 실패했습니다.`);
    } catch (err) {
      console.error(err);
    }
  };

  // 취소된 예약 되살리기 (확정 상태로 복귀, 금액·시간은 아래에서 직접 조정)
  const handleRestore = async () => {
    if (!selectedResId) return;
    if (!confirm("이 취소 예약을 다시 살릴까요?\n예약 확정 상태로 되돌립니다. (금액·시간은 아래에서 조정하세요)")) return;
    try {
      const res = await fetch(`/api/reservations/${selectedResId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CONFIRMED", isNoShow: false }),
      });
      if (res.ok) fetchReservations(selectedResId);
      else alert("되살리기에 실패했습니다.");
    } catch (err) {
      console.error(err);
    }
  };

  const handleSave = async () => {
    if (!selectedResId) return alert("기록할 예약을 먼저 선택하세요.");

    if (editDate && editStart && editEnd && editEnd <= editStart) {
      return alert("종료 시간이 시작 시간보다 빨라요. 확인해 주세요.");
    }

    // "HH:mm"(25/26시 포함) → 올바른 ISO. 24시 이상은 익일 시각으로 자동 롤오버.
    const buildISO = (dateStr: string, timeStr: string) => {
      const [y, mo, d] = dateStr.split("-").map(Number);
      const [hh, mi] = timeStr.split(":").map(Number);
      return new Date(y, mo - 1, d, hh || 0, mi || 0, 0, 0).toISOString();
    };
    const finalPrice = originalPrice + extraPrice;

    try {
      setIsSubmitting(true);
      const response = await fetch(`/api/reservations/${selectedResId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          headCount,          // 실제 이용인원
          reservedHeadCount: reserved,
          coffeeCount,
          purpose: selectedPurpose || null, // 미선택이면 null(미입력)
          detail: detail.trim() || null,
          price: finalPrice, // 캘린더/대시보드/통계에 쓰는 최종 매출액(기본 예약금 + 추가금)
          extraPrice: extraPrice,
          isExtraPaid: isExtraPaid,
          extraPaymentMethod: extraPaymentMethod,
          extraTime: extraTime,
          roomName: editRoomName, // 수정된 공간명
          memo: memo.trim() || null, // 비고란
          complaints: complaints.trim() || null, // 고객 불만사항
          isPaid,
          isCleanUpBad,
          // 시간 수정 (26시 등은 익일로 변환)
          ...(editDate && editStart ? { startTime: buildISO(editDate, editStart) } : {}),
          ...(editDate && editEnd ? { endTime: buildISO(editDate, editEnd) } : {}),
        }),
      });

      if (response.ok) {
        setSuccessMsg("이용 기록이 안전하게 저장되었습니다.");
        setTimeout(() => setSuccessMsg(""), 3000);
        alert("저장되었습니다.");
        // Refresh (선택 유지)
        fetchReservations(selectedResId);
        
        if (editDate) {
          router.push(`/calendar?date=${editDate}`);
        }
      } else {
        alert("이용 기록 저장에 실패했습니다.");
      }
    } catch (err) {
      console.error(err);
      alert("서버 연결에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getSourceDisplay = (source: string) => {
    switch (source) {
      case "naver":
        return "네이버";
      case "spacecloud":
        return "스페이스클라우드";
      case "direct":
        return "직접";
      default:
        return "직접";
    }
  };

  // 예약 루트별 글자색 (네이버=초록 / 스페이스클라우드=진한 파랑)
  const sourceTextColor = (source: string) =>
    source === "naver" ? "text-green-600"
    : source === "spacecloud" ? "text-blue-700"
    : "text-slate-500";

  // 한 줄 라벨: 날짜 · 이름 (루트색) (수기)
  const renderResLabel = (res: Reservation) => (
    <span className={`flex items-center gap-1 truncate ${res.status === "CANCELLED" ? "opacity-60" : ""}`}>
      {res.status === "CANCELLED" && <span className="text-slate-500 font-bold bg-slate-100 px-1 rounded text-xs">[취소됨]</span>}
      {res.isCleanUpBad && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-600 border border-red-500 shadow-sm shadow-red-100" title="정리상태 불량">🧹불량!</span>}
      <RpaStatusBadge memo={res.memo} createdAt={res.createdAt} updatedAt={res.updatedAt} />
      <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${res.roomName === "머무룸1" ? "bg-sky-50 text-sky-700" : res.roomName === "머무룸2" ? "bg-purple-50 text-purple-700" : "bg-slate-100 text-slate-700"}`}>{res.roomName}</span>
      <span className={res.status === "CANCELLED" ? "text-slate-500 line-through" : "text-slate-700"}>
        {formatDateLabel(res.startTime)} · {res.customerName}
      </span>
      <span className={`font-bold ${sourceTextColor(res.source)}`}>({getSourceDisplay(res.source)})</span>
      {!res.emailId && res.paymentMethod !== '온라인' && <span className="font-bold text-amber-600">✍️ 수기</span>}
      {!res.isPaid && res.paymentMethod && <span className="text-rose-600 font-bold text-[10px]">{res.paymentMethod}(미수)</span>}
    </span>
  );

  // Human readable date string formatting
  const formatDateLabel = (startTimeStr: string) => {
    const d = new Date(startTimeStr);
    const months = d.getMonth() + 1;
    const dates = d.getDate();
    const hours = d.getHours().toString().padStart(2, "0");
    const mins = d.getMinutes().toString().padStart(2, "0");
    return `${months}/${dates} ${hours}:${mins}`;
  };

  // ISO → 날짜/시간 입력값 (로컬 기준)
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const toDateInput = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const toTimeInput = (iso: string) => {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // Last 5 modified logs for displaying recent actions safely
  const recentLogs = [...reservations]
    .filter((r) => r.usageLog !== null)
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())
    .slice(0, 5);

  const selectedRes = reservations.find((r) => r.id === selectedResId);

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-5xl mx-auto w-full">
      <header className="pt-8 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">이용현황 기록</h1>
        <p className="text-sm text-slate-500 mt-1 mt-1.5 flex items-center gap-1">
          <AlertCircle className="w-4 h-4 text-slate-400" />
          CCTV 혹은 매장 방문 확인 시 실시간 기입용
        </p>
      </header>

      {/* Main logging form */}
      <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 space-y-6">
        <div>
          <label className="text-xs font-bold text-slate-500 block mb-2">대상 선택</label>
          {isLoading ? (
            <div className="text-sm text-slate-400 py-2">연동 예약 내역을 불러오는 중...</div>
          ) : (
            <div className="relative">
              {/* 현재 선택 표시 버튼 */}
              <button
                type="button"
                onClick={() => setIsSelectOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 text-sm p-3.5 rounded-xl border border-slate-200 focus:border-indigo-500 font-semibold bg-white text-slate-800"
              >
                {selectedRes ? renderResLabel(selectedRes) : <span className="text-slate-400">예약을 선택하세요</span>}
                <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${isSelectOpen ? "rotate-180" : ""}`} />
              </button>

              {/* 드롭다운 목록 */}
              {isSelectOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setIsSelectOpen(false)} />
                  <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto bg-white border border-slate-200 rounded-xl shadow-lg py-1">
                    {reservations.map((res) => (
                      <button
                        key={res.id}
                        type="button"
                        onClick={() => { handleSelectionChange(res.id); setIsSelectOpen(false); }}
                        className={`w-full text-left text-sm px-3.5 py-2.5 hover:bg-slate-50 ${res.id === selectedResId ? "bg-indigo-50" : ""}`}
                      >
                        {renderResLabel(res)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 이용 시간 수정 (분은 00/30만) */}
          {/* 공간명 수정 */}
          {selectedRes && (
            <div className="mt-3 space-y-3">
              {selectedRes.status === "CANCELLED" ? (
                <div className={`flex items-center justify-between gap-2 p-3 rounded-xl border ${selectedRes.isNoShow ? "bg-orange-50 border-orange-200" : "bg-slate-100 border-slate-200"}`}>
                  <span className={`text-sm font-semibold ${selectedRes.isNoShow ? "text-orange-700" : "text-slate-600"}`}>
                    {selectedRes.isNoShow ? "👻 노쇼 처리된 예약입니다" : "🚫 취소된 예약입니다"}
                  </span>
                  <button
                    type="button"
                    onClick={handleRestore}
                    className="px-3 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition active:scale-95 whitespace-nowrap"
                    title="다시 확정 상태로 되살리기"
                  >
                    ↩️ 되살리기
                  </button>
                </div>
              ) : (
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCancelReservation(false)}
                    className="px-2.5 py-1.5 text-[11px] font-bold text-slate-400 hover:text-amber-700 rounded-lg hover:bg-amber-50 transition active:scale-95 whitespace-nowrap"
                    title="취소 처리 (수수료 입력 — 기록 남김)"
                  >
                    🚫 취소 처리
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCancelReservation(true)}
                    className="px-2.5 py-1.5 text-[11px] font-bold text-orange-500 hover:text-orange-700 rounded-lg hover:bg-orange-50 transition active:scale-95 whitespace-nowrap"
                    title="노쇼 처리 (보통 100% 과금 — 기록 남김)"
                  >
                    👻 노쇼 처리
                  </button>
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500">이용 공간</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditRoomName("머무룸1")}
                    className={`flex-1 py-2 text-sm font-bold rounded-xl border transition ${editRoomName === "머무룸1" ? "bg-sky-50 text-sky-600 border-sky-500" : "bg-white text-slate-500 border-slate-200"}`}
                  >
                    머무룸 1
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditRoomName("머무룸2")}
                    className={`flex-1 py-2 text-sm font-bold rounded-xl border transition ${editRoomName === "머무룸2" ? "bg-purple-50 text-purple-600 border-purple-500" : "bg-white text-slate-500 border-slate-200"}`}
                  >
                    머무룸 2
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500">이용 날짜</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium text-slate-800"
                />
              </div>
              <div className="flex gap-6 items-end">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500">시작</label>
                  <TimeSelect value={editStart} onChange={handleStartTimeChange} />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500">종료 (수정 시 추가시간만 자동 반영)</label>
                  <TimeSelect value={editEnd} onChange={handleEndTimeChange} maxHour={26} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 인원/시간 컨트롤러: 예약(읽기전용) / 실제(스테퍼) / 추가(스테퍼) / 추가시간(스테퍼) */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {/* 예약 이용인원 - 메일 자동, 읽기전용 */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
              <Users className="w-4 h-4 text-slate-400" />
              예약 인원 <span className="text-[10px] font-medium text-slate-400">(메일)</span>
            </label>
            <div className="flex items-center justify-center bg-slate-100 p-2 rounded-xl border border-slate-200 h-[56px]">
              <span className="text-xl font-bold text-slate-500">{reserved}명</span>
            </div>
          </div>

          {/* 실제 이용인원 - 메인 저장값 */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
              <Users className="w-4 h-4 text-indigo-500" />
              실제 인원
            </label>
            <div className="flex items-center justify-between bg-indigo-50/60 p-2 rounded-xl border border-indigo-100">
              <button
                onClick={() => handleHeadCountChange(Math.max(0, headCount - 1))}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                -
              </button>
              <span className="text-xl font-bold text-indigo-700">{headCount}명</span>
              <button
                onClick={() => handleHeadCountChange(headCount + 1)}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                +
              </button>
            </div>
          </div>

          {/* 추가 인원 - 실제 = 예약 초과분. +/- 누르면 실제 인원에 반영 */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
              <Users className="w-4 h-4 text-emerald-500" />
              추가 인원
            </label>
            <div className="flex items-center justify-between bg-emerald-50/60 p-2 rounded-xl border border-emerald-100">
              <button
                onClick={() => handleHeadCountChange(Math.max(reserved, headCount - 1))}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                -
              </button>
              <span className="text-xl font-bold text-emerald-600">{headCount - reserved > 0 ? `+${headCount - reserved}` : 0}명</span>
              <button
                onClick={() => handleHeadCountChange(headCount + 1)}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                +
              </button>
            </div>
          </div>

          {/* 추가 시간 - 스테퍼 */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
              <Clock className="w-4 h-4 text-emerald-500" />
              추가 시간
            </label>
            <div className="flex items-center justify-between bg-emerald-50/60 p-2 rounded-xl border border-emerald-100">
              <button
                onClick={() => addExtraTime(-1)}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                -
              </button>
              <span className="text-xl font-bold text-emerald-600">{extraTime > 0 ? `+${extraTime}` : extraTime}시간</span>
              <button
                onClick={() => addExtraTime(1)}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                +
              </button>
            </div>
          </div>

          {/* 제공된 커피 */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
              <Coffee className="w-4 h-4 text-amber-500" />
              제공된 커피
            </label>
            <div className="flex items-center justify-between bg-slate-50 p-2 rounded-xl border border-slate-200">
              <button
                onClick={() => setCoffeeCount(Math.max(0, coffeeCount - 1))}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                -
              </button>
              <span className="text-xl font-bold text-slate-900">{coffeeCount}잔</span>
              <button
                onClick={() => setCoffeeCount(coffeeCount + 1)}
                className="w-10 h-10 rounded-lg bg-white shadow-sm flex items-center justify-center font-bold text-slate-700 text-lg hover:bg-slate-50 border border-slate-200 transition active:scale-90"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* 이용 목적 - 대분류 선택 */}
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
            <Tag className="w-4 h-4 text-emerald-500" />
            이용 목적 <span className="text-xs font-medium text-slate-400">(대분류)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {MAJOR_CATEGORIES.map((purpose) => {
              const isSelected = selectedPurpose === purpose;
              return (
                <button
                  type="button"
                  key={purpose}
                  onClick={() => setSelectedPurpose(isSelected ? "" : purpose)}
                  className={`py-2.5 rounded-xl border text-sm font-semibold transition duration-150 active:scale-95 ${
                    isSelected
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {purpose}
                </button>
              );
            })}
          </div>
        </div>

        {/* 세부내용 - 자유 입력 */}
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
            <Pencil className="w-4 h-4 text-sky-500" />
            세부내용 <span className="text-xs font-medium text-slate-400">(소분류 · 선택 입력)</span>
          </label>

          {/* 대분류별 빠른선택 칩 (누르면 세부내용 자동 입력, 직접 타이핑도 가능) */}
          {selectedPurpose && (SUB_CATEGORIES[selectedPurpose]?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2">
              {SUB_CATEGORIES[selectedPurpose].map((sub) => {
                const active = detail === sub;
                return (
                  <button
                    type="button"
                    key={sub}
                    onClick={() => setDetail(active ? "" : sub)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition active:scale-95 ${
                      active
                        ? "bg-sky-500 text-white border-sky-500"
                        : "bg-sky-50 text-sky-700 border-sky-100 hover:bg-sky-100"
                    }`}
                  >
                    {sub}
                  </button>
                );
              })}
            </div>
          )}

          <input
            type="text"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={
              selectedPurpose
                ? "위 칩을 누르거나 직접 입력하세요 (예: 보험교육)"
                : "대분류를 먼저 선택하면 추천 소분류가 떠요 (직접 입력도 가능)"
            }
            className="w-full text-sm p-3.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium text-slate-800"
          />
        </div>

        {/* 결제 금액 수정 폼 */}
        {selectedRes && (
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <label className="text-sm font-semibold text-slate-700 flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Wallet className="w-4 h-4 text-emerald-600" />
                최종 매출액
              </span>
              <span className="text-xs font-medium text-slate-400">캘린더에는 기본 예약금 + 추가금 합계가 표시됩니다.</span>
            </label>
            
            {/* 금액 상세 내역 (원래 금액 / 추가 금액) */}
            <div className="mb-2 p-3 bg-slate-50 border border-slate-200 rounded-xl flex flex-col gap-3 text-sm shadow-inner">
              <div className="flex justify-between items-center">
                <div className="space-y-0.5 flex flex-col">
                  <p className="text-slate-500 font-medium text-sm">예약 기본금액</p>
                  <div className="relative mt-1">
                    <input 
                      type="text"
                      value={originalPrice === 0 ? '' : originalPrice.toLocaleString()}
                      placeholder="0"
                      onChange={(e) => {
                        const valStr = e.target.value.replace(/,/g, '');
                        if (!/^\d*$/.test(valStr)) return;
                        const val = Number(valStr);
                        setOriginalPrice(val);
                        setCurrentPrice(val + extraPrice);
                      }}
                      className="w-32 text-left bg-white border border-slate-200 text-slate-700 font-bold text-lg p-1.5 pl-2 pr-6 rounded-lg outline-hidden focus:border-slate-400 shadow-xs transition-all"
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm pointer-events-none">원</span>
                  </div>
                </div>
                <div className="text-slate-300 font-bold px-2">+</div>
                <div className="space-y-0.5 text-right flex flex-col items-end">
                  <p className="text-rose-500 font-medium text-sm">추가금 기록</p>
                  <div className="relative mt-1">
                    <input 
                      type="text"
                      value={extraPrice === 0 ? '' : extraPrice.toLocaleString()}
                      placeholder="0"
                      onChange={(e) => {
                        const valStr = e.target.value.replace(/,/g, '');
                        if (!/^\d*$/.test(valStr)) return;
                        const val = Number(valStr);
                        setExtraPrice(val);
                        setCurrentPrice(originalPrice + val);
                      }}
                      className="w-32 text-right bg-white border-2 border-rose-200 text-rose-600 font-bold text-lg p-1.5 pr-6 rounded-lg outline-hidden focus:border-rose-400 shadow-xs transition-all"
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-rose-400 font-bold text-sm pointer-events-none">원</span>
                  </div>
                </div>
              </div>

              {extraPrice > 0 && (
                <div className="pt-3 border-t border-slate-200 flex justify-between items-center">
                  <p className="text-sm font-semibold text-slate-600">추가금 결제 정보</p>
                  <div className="flex items-center gap-2">
                    <select
                      value={extraPaymentMethod}
                      onChange={(e) => setExtraPaymentMethod(e.target.value)}
                      className="w-24 text-xs p-1.5 rounded-md border border-slate-200 bg-white text-slate-600 outline-hidden focus:border-indigo-500"
                    >
                      <option value="계좌이체">계좌이체</option>
                      <option value="카드결제">카드결제</option>
                    </select>
                    <label className={`flex items-center gap-1.5 cursor-pointer px-2 py-1.5 rounded-md border transition-colors ${
                      isExtraPaid ? 'bg-emerald-50/50 border-emerald-200' : 'bg-red-50 border-red-300'
                    }`}>
                      <input 
                        type="checkbox" 
                        checked={isExtraPaid}
                        onChange={(e) => setIsExtraPaid(e.target.checked)}
                        className={`w-3.5 h-3.5 rounded focus:ring-2 cursor-pointer ${
                          isExtraPaid ? 'text-emerald-500 focus:ring-emerald-500 accent-emerald-500' : 'text-red-500 focus:ring-red-500 accent-red-500'
                        }`} 
                      />
                      <span className={`text-xs font-bold ${
                        isExtraPaid ? 'text-emerald-600' : 'text-red-600'
                      }`}>
                        {isExtraPaid ? '결제 완료' : '미결제 ★'}
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-4 items-center">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={currentPrice === 0 ? '' : currentPrice.toLocaleString()}
                  onChange={(e) => {
                    const valStr = e.target.value.replace(/,/g, '');
                    if (!/^\d*$/.test(valStr)) return;
                    const val = Number(valStr);
                    setCurrentPrice(val);
                    setOriginalPrice(Math.max(0, val - extraPrice));
                  }}
                  className="w-full text-lg p-3.5 pl-10 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-bold text-slate-800 bg-emerald-50/30"
                />
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">₩</span>
              </div>
              <button
                type="button"
                onClick={() => setIsPaid(!isPaid)}
                className={`py-3.5 px-4 rounded-xl font-bold border transition whitespace-nowrap ${isPaid ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}
              >
                {isPaid ? "결제 완료" : "미수금"}
              </button>
            </div>
          </div>
        )}

        {/* 비고란 (관리자용 자유 메모) */}
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <label className="text-sm font-semibold text-slate-700 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Pencil className="w-4 h-4 text-slate-400" />
              비고 및 관리자 메모
            </span>
          </label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="특이사항, 분실물 등을 자유롭게 적어주세요."
            rows={2}
            className="w-full text-sm p-3.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium text-slate-800 resize-none bg-slate-50"
          />
        </div>

        {/* 고객 불만사항 전용 */}
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <label className="text-sm font-semibold text-rose-700 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <AlertCircle className="w-4 h-4 text-rose-500" />
              고객 불만사항 (CS 기록)
            </span>
          </label>
          <textarea
            value={complaints}
            onChange={(e) => setComplaints(e.target.value)}
            placeholder="고객 불만사항이 발생한 경우, 나중에 모아보기 위해 여기에 상세히 기록해 주세요."
            rows={3}
            className="w-full text-sm p-3.5 rounded-xl border border-rose-200 outline-hidden focus:border-rose-500 font-medium text-rose-900 resize-none bg-rose-50"
          />
        </div>

        {/* 고객 상태 플래그 */}
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <label className="text-sm font-semibold text-slate-700 flex items-center gap-1">
            <AlertCircle className="w-4 h-4 text-orange-500" />
            고객 상태 플래그
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setIsCleanUpBad(!isCleanUpBad)}
              className={`py-2 px-4 rounded-xl border font-bold text-sm transition ${isCleanUpBad ? "bg-orange-50 text-orange-700 border-orange-200" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}`}
            >
              {isCleanUpBad ? "🧹 정리불량 (체크됨)" : "🧹 정리상태 불량 표시"}
            </button>
          </div>
        </div>

        {/* Submit action */}
        <div className="pt-2">
          {successMsg && (
            <p className="text-xs bg-emerald-550/10 text-emerald-600 border border-emerald-100 p-2.5 rounded-lg mb-3 text-center font-bold animate-pulse">
              {successMsg}
            </p>
          )}

          <button
            onClick={handleSave}
            disabled={isSubmitting}
            className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition active:scale-[0.98] flex justify-center items-center gap-2"
          >
            <Check className="w-5 h-5" />
            {isSubmitting ? "저장하는 중..." : "이용 현황 저장하기"}
          </button>
        </div>
      </section>

      {/* History Log Feed Section */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          최근 기록 피드
          <Search className="w-4 h-4 text-slate-400" />
        </h2>
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 divide-y divide-slate-100 overflow-hidden">
          {isLoading ? (
            <div className="text-center py-6 text-slate-400 text-xs">피드를 불러오는 중...</div>
          ) : recentLogs.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">입력된 최근 내역이 없습니다.</div>
          ) : (
            recentLogs.map((log) => {
              const parsedDateStr = formatDateLabel(log.startTime);
              return (
                <div key={log.id} className="p-4 flex justify-between items-center bg-white hover:bg-slate-50/50 transition">
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 flex items-center gap-1">
                      {log.isCleanUpBad && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-600 border border-red-500 shadow-sm shadow-red-100" title="정리상태 불량">🧹불량!</span>}
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${log.roomName === "머무룸1" ? "bg-sky-50 text-sky-700" : log.roomName === "머무룸2" ? "bg-purple-50 text-purple-700" : "bg-slate-100 text-slate-700"}`}>
                        {log.roomName}
                      </span>
                      {parsedDateStr} ({log.customerName || "미지정"})
                      {!log.isPaid && log.paymentMethod && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-600 border border-rose-200">{log.paymentMethod}(미수)</span>}
                    </p>
                    <p className="text-xs text-slate-500 font-semibold">
                      실제 <span className="text-slate-800">{log.usageLog?.headCount || 1}명</span>
                      {(() => {
                        const r = log.usageLog?.reservedHeadCount ?? 0;
                        const h = log.usageLog?.headCount ?? 0;
                        return r > 0 && r !== h ? <span className="text-slate-400 font-medium"> (예약 {r})</span> : null;
                      })()} · 커피{" "}
                      <span className="text-slate-800">{log.usageLog?.coffeeCount || 0}잔</span> · 목적{" "}
                      <span className="text-indigo-600 font-bold">#{log.usageLog?.purpose || UNCATEGORIZED_LABEL}</span>
                      {log.usageLog?.detail && (
                        <span className="text-slate-400 font-medium"> · {log.usageLog.detail}</span>
                      )}
                    </p>
                    {log.memo && (
                      <p className="text-[11px] font-medium text-slate-600 bg-slate-100 p-1.5 rounded mt-1">
                        비고: {log.memo}
                      </p>
                    )}
                    {log.complaints && (
                      <p className="text-[11px] font-medium text-rose-700 bg-rose-100 p-1.5 rounded mt-1 border border-rose-200">
                        ⚠️ 불만사항: {log.complaints}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] font-bold text-slate-400">
                    {getSourceDisplay(log.source)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
