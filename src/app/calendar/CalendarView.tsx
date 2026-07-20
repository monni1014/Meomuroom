"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, Clock, User, Trash2, X, Wallet, RefreshCw, Copy, Pencil, Phone, Star } from "lucide-react";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { MAJOR_CATEGORIES, UNCATEGORIZED_LABEL } from "@/lib/categories";
import { CUSTOMER_TYPE_LABELS, normalizeCustomerType, type CustomerType } from "@/lib/customer-types";
import TimeSelect from "@/components/TimeSelect";
import MultiDatePicker from "@/components/MultiDatePicker";
import RpaStatusBadge from "@/components/RpaStatusBadge";
import { createKstDate, getKstDateParts } from "@/lib/kst-time";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";

interface UsageLog {
  id: string;
  headCount: number;
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
  customerType: CustomerType;
  phone: string | null;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
  notified: boolean;
  notifiedAt: string | null;
  notificationStatus: string | null;
  notificationChannel: string | null;
  notificationError: string | null;
  price: number;
  discount: number;
  status: string;
  isNoShow: boolean;
  paymentMethod: string | null;
  isPaid: boolean;
  memo: string | null;
  complaints: string | null;
  isCleanUpBad: boolean;
  emailId: string | null; // null = 수기 입력 (메일 자동연동 아님)
  usageLog: UsageLog | null;
}

const ROOM_FILTERS = ["all", "머무룸1", "머무룸2", "머무룸3"] as const;
type RoomFilter = (typeof ROOM_FILTERS)[number];

function normalizeRoomFilter(value: string | null): RoomFilter {
  return ROOM_FILTERS.includes(value as RoomFilter) ? (value as RoomFilter) : "all";
}

function calendarDateFromParam(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date();
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseClockMinutes(value: string) {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 26 || minute < 0 || minute > 59) {
    return Number.NaN;
  }

  return hour * 60 + minute;
}

function normalizeEndClock(startClock: string, endClock: string) {
  const startMinutes = parseClockMinutes(startClock);
  const endMinutes = parseClockMinutes(endClock);

  if (endMinutes === 0 && startMinutes > 0) {
    return "24:00";
  }

  return endClock;
}

function buildLocalDateTime(dateText: string, clockText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  const minutes = parseClockMinutes(clockText);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  return createKstDate(year, month, day, hour, minute);
}

function formatClock(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extendedEndClock(start: Date, end: Date) {
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const startParts = getKstDateParts(start);
  const endParts = getKstDateParts(end);
  const totalMinutes = startParts.hour * 60 + startParts.minute + durationMinutes;

  if (durationMinutes > 0 && totalMinutes <= 26 * 60) {
    return formatClock(totalMinutes);
  }

  return `${String(endParts.hour).padStart(2, "0")}:${String(endParts.minute).padStart(2, "0")}`;
}

function formatDuration(start: Date, end: Date) {
  const totalMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`;
}

export default function CalendarPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dateParam = searchParams.get("date");
  const initialDate = calendarDateFromParam(dateParam);
  const initialRoomFilter = normalizeRoomFilter(searchParams.get("room"));

  const [currentDate, setCurrentDate] = useState(initialDate);
  const [selectedDate, setSelectedDate] = useState<Date>(initialDate);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<RoomFilter>(initialRoomFilter);

  const [modalMode, setModalMode] = useState<"create" | "edit" | "copy">("create");
  const [editId, setEditId] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [customerType, setCustomerType] = useState<CustomerType>("UNSPECIFIED");
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("온라인");
  const [isPaid, setIsPaid] = useState(true);
  const [isCleanUpBad, setIsCleanUpBad] = useState(false);
  const [memo, setMemo] = useState("");
  const [complaints, setComplaints] = useState("");
  const [formSource, setFormSource] = useState("naver"); // 예약 루트 (네이버/스페이스클라우드)
  const [formRoom, setFormRoom] = useState("머무룸1");
  const [formDates, setFormDates] = useState<string[]>([format(new Date(), "yyyy-MM-dd")]);

  const [formStartTime, setFormStartTime] = useState("14:00");
  const [formEndTime, setFormEndTime] = useState("17:00");
  const [formPrice, setFormPrice] = useState("30000");
  const [formGuests, setFormGuests] = useState("4");
  const [formPurpose, setFormPurpose] = useState(""); // 대분류
  const [formDetail, setFormDetail] = useState(""); // 세부내용
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showMultiPicker, setShowMultiPicker] = useState(false);

  const fetchReservations = useCallback(async () => {
    try {
      const res = await fetch("/api/reservations");
      if (res.ok) {
        const data = await res.json();
        setReservations(data);
      }
    } catch (err) {
      console.error("Failed to load reservations:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchReservations();
  }, [fetchReservations]);

  useDataChangePolling(
    "/api/data-version?scope=reservations",
    fetchReservations,
  );

  const replaceCalendarState = (date: Date, room: RoomFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("date", format(date, "yyyy-MM-dd"));
    params.set("room", room);
    window.history.replaceState(null, "", `/calendar?${params.toString()}`);
  };

  const handleSyncEmails = async () => {
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/email-sync");
      const data = await res.json();
      if (data.success) {
        setSyncMessage(`✅ ${data.message}`);
        fetchReservations();
      } else {
        setSyncMessage(`❌ 동기화 실패: ${data.error}`);
      }
    } catch {
      setSyncMessage("❌ 메일 서버 연결에 실패했습니다.");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncMessage(null), 5000);
    }
  };

  const firstDay = startOfMonth(currentDate);
  const lastDay = endOfMonth(currentDate);
  const daysInMonth = eachDayOfInterval({ start: firstDay, end: lastDay });

  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));

  // Filter reservations for the selected date and room
  const filteredReservations = roomFilter === "all" 
    ? reservations 
    : reservations.filter((res) => res.roomName === roomFilter);

  const selectedReservations = filteredReservations.filter((res) =>
    isSameDay(new Date(res.startTime), selectedDate)
  );

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return alert("예약자명을 입력하세요.");
    if (formDates.length === 0) return alert("예약 일자를 하나 이상 선택하세요.");

    const normalizedEndTime = normalizeEndClock(formStartTime, formEndTime);
    const startMinutes = parseClockMinutes(formStartTime);
    const endMinutes = parseClockMinutes(normalizedEndTime);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      return alert("종료 시간은 시작 시간보다 늦어야 합니다.");
    }

    try {
      setIsSubmitting(true);

      const buildPayload = (dateStr: string) => {
        const startDateTime = buildLocalDateTime(dateStr, formStartTime);
        const endDateTime = buildLocalDateTime(dateStr, normalizedEndTime);

        return {
          source: formSource,
          roomName: formRoom,
          customerName: formName,
          customerType,
          phone: formPhone.trim() || null,
          startTime: startDateTime.toISOString(),
          endTime: endDateTime.toISOString(),
          price: parseInt(formPrice.replace(/,/g, ''), 10) || 0,
          discount: discount,
          paymentMethod: paymentMethod,
          isPaid,
          isCleanUpBad,
          memo: memo.trim() || null,
          complaints: complaints.trim() || null,
          headCount: parseInt(formGuests, 10) || 1,
          purpose: formPurpose || null,
          detail: formDetail.trim() || null,
        };
      };

      if (modalMode === "edit" && editId) {
        const res = await fetch(`/api/reservations/${editId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload(formDates[0])),
        });
        if (!res.ok) throw new Error("수정 실패");
      } else {
        const promises = formDates.map((dateStr) =>
          fetch("/api/reservations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildPayload(dateStr)),
          })
        );
        const results = await Promise.all(promises);
        if (results.some(r => !r.ok)) throw new Error("생성 실패");
      }

      setFormName("");
      setFormPhone("");
      setCustomerType("UNSPECIFIED");
      setFormPurpose("");
      setFormDetail("");
      setDiscount(0);
      setPaymentMethod("온라인");
      setIsPaid(true);
      setIsCleanUpBad(false);
      setMemo("");
      setComplaints("");
      setFormSource("naver");
      setIsModalOpen(false);
      fetchReservations();
      alert("저장되었습니다.");
    } catch (error) {
      console.error("Save error:", error);
      alert("예약 저장에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const fillFormForRes = (res: Reservation) => {
    const s = new Date(res.startTime);
    const e = new Date(res.endTime);
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    setFormName(res.customerName || "");
    setFormPhone(res.phone || "");
    setCustomerType(normalizeCustomerType(res.customerType));
    setFormSource(res.source === "spacecloud" ? "spacecloud" : "naver");
    setFormRoom(res.roomName || "머무룸1");
    setFormDates([format(s, "yyyy-MM-dd")]);
    setFormStartTime(hhmm(s));
    setFormEndTime(extendedEndClock(s, e));
    setFormPrice(res.price ? res.price.toLocaleString() : "0");
    setDiscount(res.discount || 0);
    setPaymentMethod(res.paymentMethod || "온라인");
    setIsPaid(res.isPaid ?? true);
    setIsCleanUpBad(res.isCleanUpBad ?? false);
    setMemo(res.memo || "");
    setComplaints(res.complaints || "");
    setFormGuests(String(res.usageLog?.headCount || 1));
    setFormPurpose(res.usageLog?.purpose || "");
    setFormDetail(res.usageLog?.detail || "");
    setShowMultiPicker(false);
  };

  const openEditModal = (res: Reservation) => {
    setModalMode("edit");
    setEditId(res.id);
    fillFormForRes(res);
    setShowMultiPicker(false);
    setIsModalOpen(true);
  };

  const openCopyModal = (res: Reservation) => {
    setModalMode("copy");
    setEditId(null);
    fillFormForRes(res);
    setFormDates([]); 
    setShowMultiPicker(false); 
    setIsModalOpen(true);
  };

  const handleMarkPaid = async (id: string) => {
    try {
      const res = await fetch(`/api/reservations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPaid: true }),
      });
      if (res.ok) fetchReservations();
      else alert("결제완료 처리에 실패했습니다.");
    } catch (err) {
      console.error(err);
    }
  };

  // 수동 취소/노쇼 (기록 남기고 수수료를 매출로 반영. 수수료 없으면 삭제하면 됨)
  // isNoShow=true면 노쇼(보통 100% 과금), false면 일반 취소. 매출·집계 처리는 동일, 표기만 구분.
  const handleCancel = async (id: string, currentPrice: number, isNoShow: boolean) => {
    const label = isNoShow ? "노쇼" : "취소";
    const feeStr = prompt(
      `${label} 처리합니다.\n${label} 수수료(매출로 잡힐 금액)를 입력하세요.\n· 수수료 없음 → 0\n· 전액(100%) → ${currentPrice.toLocaleString()}원`,
      String(currentPrice)
    );
    if (feeStr === null) return; // 입력창 취소
    const fee = parseInt(feeStr.replace(/[^\d]/g, ""), 10);
    if (isNaN(fee)) { alert("숫자를 입력해 주세요."); return; }
    try {
      const res = await fetch(`/api/reservations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", price: fee, isNoShow }),
      });
      if (res.ok) fetchReservations();
      else alert(`${label} 처리에 실패했습니다.`);
    } catch (err) {
      console.error(err);
    }
  };

  // 취소된 예약 되살리기 (예: 전날취소 100% 수수료 → 수동으로 일정 조정 후 다시 확정)
  const handleRestore = async (id: string) => {
    if (!confirm("이 취소 예약을 다시 살릴까요?\n예약 확정 상태로 되돌립니다. (금액·시간은 이용현황에서 따로 조정하세요)")) return;
    try {
      const res = await fetch(`/api/reservations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CONFIRMED", isNoShow: false }),
      });
      if (res.ok) fetchReservations();
      else alert("되살리기에 실패했습니다.");
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteReservation = async (id: string) => {
    if (!confirm("정말로 이 예약을 취소하시겠습니까?")) return;

    try {
      const res = await fetch(`/api/reservations/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchReservations();
      } else {
        alert("예약 취소에 실패했습니다.");
      }
    } catch (err) {
      console.error(err);
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

  const getSourceBadgeStyle = (source: string) => {
    switch (source) {
      case "naver":
        return "bg-green-50 text-green-700 border border-green-100";
      case "spacecloud":
        return "bg-indigo-50 text-indigo-700 border border-indigo-100";
      default:
        return "bg-amber-50 text-amber-700 border border-amber-100";
    }
  };

  const getRoomBadgeStyle = (room: string) => {
    switch (room) {
      case "머무룸1":
        return "bg-sky-50 text-sky-700 border border-sky-100";
      case "머무룸2":
        return "bg-purple-50 text-purple-700 border border-purple-100";
      case "머무룸3":
        return "bg-orange-50 text-orange-700 border border-orange-200";
      default:
        return "bg-slate-50 text-slate-700 border border-slate-100";
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-7xl mx-auto w-full">
      <header className="pt-8 pb-4 flex justify-between items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">통합 캘린더</h1>
          <p className="text-sm text-slate-500 mt-1">네이버 및 스페이스클라우드 예약 실시간 조회</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSyncEmails}
            disabled={isSyncing}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl shadow-md text-sm font-bold transition-all active:scale-95 whitespace-nowrap",
              isSyncing ? "bg-slate-400 cursor-wait" : "bg-emerald-600 hover:bg-emerald-700",
              "text-white"
            )}
            title="메일 동기화"
          >
            <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
            {isSyncing ? "동기화 중..." : "메일 동기화"}
          </button>
          <button
            onClick={() => {
              setModalMode("create");
              setEditId(null);
              setFormDates([format(selectedDate, "yyyy-MM-dd")]);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl shadow-md hover:bg-indigo-700 active:scale-95 transition-all whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            수동 예약 추가
          </button>
        </div>
      </header>

      {/* Sync Message Toast */}
      {syncMessage && (
        <div className={cn(
          "px-4 py-3 rounded-xl text-sm font-medium shadow-sm border animate-in fade-in slide-in-from-top-2 duration-300",
          syncMessage.startsWith("✅") ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-rose-50 text-rose-700 border-rose-100"
        )}>
          {syncMessage}
        </div>
      )}

      {/* Room Filter Tabs */}
      <div className="flex flex-wrap gap-2">
        {ROOM_FILTERS.map((room) => (
          <button
            key={room}
            onClick={() => {
              setRoomFilter(room);
              replaceCalendarState(selectedDate, room);
            }}
            className={cn(
              "px-4 py-2 rounded-xl text-sm font-semibold transition-all active:scale-95 border",
              roomFilter === room
                ? "bg-indigo-600 text-white border-indigo-600 shadow-md"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            )}
          >
            {room === "all" ? "전체" : room}
          </button>
        ))}
      </div>

      {/* 데스크톱에서는 달력과 일정 목록을 좌우로 배치 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* Calendar Grid Section */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 flex flex-col">
        {/* Calendar Header Nav */}
        <div className="flex justify-between items-center mb-6">
          <button onClick={prevMonth} className="p-1 rounded-full hover:bg-slate-50 active:scale-95 transition-all">
            <ChevronLeft className="w-6 h-6 text-slate-600" />
          </button>
          <h2 className="text-lg font-semibold text-slate-800">
            {format(currentDate, "yyyy년 MM월")}
          </h2>
          <button onClick={nextMonth} className="p-1 rounded-full hover:bg-slate-50 active:scale-95 transition-all">
            <ChevronRight className="w-6 h-6 text-slate-600" />
          </button>
        </div>

        {/* Days of Week Row */}
        <div className="grid grid-cols-7 gap-1 mb-2">
          {["일", "월", "화", "수", "목", "금", "토"].map((day, idx) => (
            <div
              key={day}
              className={cn(
                "text-center text-xs font-semibold text-slate-400 py-2",
                idx === 0 && "text-rose-400",
                idx === 6 && "text-rose-400"
              )}
            >
              {day}
            </div>
          ))}
        </div>

        {/* Days of Month Grid */}
        <div className="grid grid-cols-7 gap-1 flex-1">
          {Array.from({ length: firstDay.getDay() }).map((_, i) => (
            <div key={`empty-${i}`} className="p-2" />
          ))}
          {daysInMonth.map((day) => {
            const isToday = isSameDay(day, new Date());
            const isSelected = isSameDay(day, selectedDate);
            const isSameMonthOfActive = isSameMonth(day, currentDate);

            // Filter reservations for this day
            const dayReservations = filteredReservations.filter((res) =>
              isSameDay(new Date(res.startTime), day)
            );
            
            const hasUnpaid = dayReservations.some((res) => !res.isPaid && res.status !== "CANCELLED");
            const hasUnpaidExtra = dayReservations.some((res) => res.usageLog && (res.usageLog.extraPrice ?? 0) > 0 && !res.usageLog.isExtraPaid && res.status !== "CANCELLED");

            return (
              <button
                key={day.toISOString()}
                onClick={() => {
                  setSelectedDate(day);
                  replaceCalendarState(day, roomFilter);
                }}
                className={cn(
                  "flex flex-col items-center justify-between p-1.5 min-h-[55px] rounded-xl relative transition-all active:scale-95",
                  isSelected
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-100"
                    : isToday
                    ? "bg-indigo-50 text-indigo-700"
                    : "hover:bg-slate-50 text-slate-700",
                  !isSameMonthOfActive && "opacity-30"
                )}
              >
                <div className="relative inline-flex items-center">
                  <span className={cn("text-sm font-semibold", (day.getDay() === 0 || day.getDay() === 6) && !isSelected && "text-rose-500")}>
                    {format(day, "d")}
                  </span>
                  {(hasUnpaid || hasUnpaidExtra) && (
                    <div className="absolute -top-1 -right-3 flex gap-0.5" title="미결제/미수금 예약 있음">
                      {hasUnpaid && <Star className="w-2.5 h-2.5 text-amber-500 fill-amber-400 drop-shadow-sm" />}
                      {hasUnpaidExtra && <Star className="w-2.5 h-2.5 text-red-500 fill-red-500 drop-shadow-sm animate-pulse" />}
                    </div>
                  )}
                </div>
                
                {/* Dots container for day's reservations */}
                <div className="flex gap-0.5 justify-center h-2 mt-1">
                  {dayReservations.map((res) => {
                    const dotClass =
                      res.status === "CANCELLED" ? "bg-slate-300" :
                      !res.isPaid ? (res.source === "naver" ? "bg-rose-400" : res.source === "spacecloud" ? "bg-rose-700" : "bg-rose-500") :
                      res.source === "naver" ? "bg-green-500" :
                      res.source === "spacecloud" ? "bg-indigo-500" : "bg-amber-500";
                    return (
                      <span
                        key={res.id}
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          isSelected ? "bg-white" : dotClass
                        )}
                      />
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Selected Day Reservations List */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 space-y-4">
        <div className="flex justify-between items-center pb-2 border-b border-slate-50">
          <h3 className="text-sm font-bold text-slate-800">
            {format(selectedDate, "M월 d일")} 일정 ({selectedReservations.length}건)
          </h3>
          <span className="text-xs text-slate-400">선택한 날짜별 예약</span>
        </div>

        <div className="space-y-3">
          {isLoading ? (
            <div className="text-center py-6 text-slate-400 text-xs">예약 데이터를 불러오는 중...</div>
          ) : selectedReservations.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              이날 잡힌 예약이 없습니다. 우측 상단 &quot;+&quot; 버튼으로 수동 예약을 추가할 수 있습니다.
            </div>
          ) : (
            selectedReservations.map((res) => {
              const start = new Date(res.startTime);
              const end = new Date(res.endTime);
              const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
              const displayEndTime = extendedEndClock(start, end);
              const isCancelled = res.status === "CANCELLED";

              return (
                <div
                  key={res.id}
                  onDoubleClick={() => {
                    replaceCalendarState(selectedDate, roomFilter);
                    const params = new URLSearchParams({
                      selected: res.id,
                      fromDate: format(selectedDate, "yyyy-MM-dd"),
                      fromRoom: roomFilter,
                    });
                    router.push(`/usage?${params.toString()}`);
                  }}
                  title="더블클릭하면 이용현황에서 수정"
                  className={cn(
                    "relative p-4 rounded-xl border flex justify-between items-start gap-2 cursor-pointer select-none",
                    isCancelled ? "bg-slate-100 border-slate-200" : "bg-slate-50 border-slate-100 hover:border-indigo-200"
                  )}
                >
                  <div className="space-y-2 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {isCancelled && (
                        res.isNoShow ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-300">
                            👻 노쇼
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-600">
                            🚫 취소됨
                          </span>
                        )
                      )}
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", getSourceBadgeStyle(res.source))}>
                        {getSourceDisplay(res.source)}
                      </span>
                      {!res.emailId && res.paymentMethod !== '온라인' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-100">
                          ✍️수기
                        </span>
                      )}
                      {res.isCleanUpBad && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-600 border border-red-500 shadow-sm shadow-red-100" title="정리상태 불량">
                          🧹불량!
                        </span>
                      )}
                      <RpaStatusBadge memo={res.memo} createdAt={res.createdAt} updatedAt={res.updatedAt} />
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", getRoomBadgeStyle(res.roomName))}>
                        {res.roomName}
                      </span>
                      <strong className={cn("text-sm", isCancelled ? "text-slate-500 line-through" : "text-slate-900")}>
                        {res.customerName}
                      </strong>
                      {!isCancelled && res.paymentMethod && (
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-semibold border",
                          res.isPaid 
                            ? "bg-slate-100 text-slate-600 border-slate-200" 
                            : "bg-rose-50 text-rose-600 border-rose-300 shadow-sm shadow-rose-100"
                        )}>
                          {res.paymentMethod}{!res.isPaid && "(미수)"}
                        </span>
                      )}
                      {!isCancelled && res.usageLog && (res.usageLog.extraPrice ?? 0) > 0 && (
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-semibold border",
                          res.usageLog.isExtraPaid 
                            ? "bg-emerald-50 text-emerald-600 border-emerald-200" 
                            : "bg-rose-50 text-rose-600 border-rose-300 shadow-sm shadow-rose-100"
                        )}>
                          추가금 {res.usageLog.extraPaymentMethod ? `(${res.usageLog.extraPaymentMethod})` : ""}{!res.usageLog.isExtraPaid && " 미결제★"}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-y-1 gap-x-4 text-xs text-slate-500">
                      <p className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{formatTime(start)} - {displayEndTime} ({formatDuration(start, end)})</span>
                      </p>
                      <p className="flex items-center gap-1">
                        <User className="w-3.5 h-3.5" />
                        <span>인원: {res.usageLog?.headCount || 1}명 ({res.usageLog?.purpose || UNCATEGORIZED_LABEL}{res.usageLog?.detail ? ` · ${res.usageLog.detail}` : ""})</span>
                      </p>
                      {res.price > 0 && (
                        <p className="flex items-center gap-1 text-slate-700">
                          <Wallet className="w-3.5 h-3.5 text-slate-400" />
                          <span>{isCancelled ? "수수료" : "요금"}: <strong className="text-slate-800">{res.price.toLocaleString()}원</strong></span>
                        </p>
                      )}
                      {res.phone && (
                        <p className="flex items-center gap-1">
                          <Phone className="w-3.5 h-3.5" />
                          <span className={cn(isCancelled ? "line-through text-slate-400" : "")}>{res.phone}</span>
                        </p>
                      )}
                      {!isCancelled && res.discount > 0 && (
                        <p className="flex items-center gap-1 text-rose-600">
                          <span>🎟️ 쿠폰 사용: -{res.discount.toLocaleString()}원</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 pt-5">
                    {isCancelled && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRestore(res.id); }}
                        className="px-2.5 py-1.5 text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition active:scale-95 whitespace-nowrap"
                        title="취소된 예약을 다시 확정 상태로 되살리기"
                      >
                        ↩️ 되살리기
                      </button>
                    )}
                    {!isCancelled && !res.isPaid && (
                      <button
                        onClick={() => handleMarkPaid(res.id)}
                        className="px-2.5 py-1.5 text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition active:scale-95 whitespace-nowrap"
                        title="결제완료로 변경"
                      >
                        결제완료 처리
                      </button>
                    )}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditModal(res); }}
                        className="p-2 text-slate-400 hover:text-emerald-500 rounded-lg hover:bg-emerald-50 transition active:scale-95"
                        title="예약 직접 수정하기"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); openCopyModal(res); }}
                        className="p-2 text-slate-400 hover:text-indigo-500 rounded-lg hover:bg-indigo-50 transition active:scale-95"
                        title="이 예약 복사 (반복 예약 빠르게 추가)"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      {!isCancelled && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCancel(res.id, res.price, false); }}
                            className="px-2 py-1.5 text-[11px] font-bold text-slate-500 hover:text-amber-700 rounded-lg hover:bg-amber-50 transition active:scale-95 whitespace-nowrap"
                            title="취소 처리 (수수료 입력 — 기록 남김)"
                          >
                            취소
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCancel(res.id, res.price, true); }}
                            className="px-2 py-1.5 text-[11px] font-bold text-orange-500 hover:text-orange-700 rounded-lg hover:bg-orange-50 transition active:scale-95 whitespace-nowrap"
                            title="노쇼 처리 (보통 100% 과금 — 기록 남김)"
                          >
                            노쇼
                          </button>
                        </>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteReservation(res.id); }}
                        className="p-2 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 transition active:scale-95"
                        title="예약 및 로그 완전 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
      </div>

      {/* Manual Booking Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-4 flex justify-between items-center border-b border-slate-100 bg-slate-50">
              <h2 className="font-bold text-slate-800">
                {modalMode === "edit" ? "예약 일정 수정" : modalMode === "copy" ? "다중 날짜로 여러번 복사" : "새 수동 예약 추가"}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-full text-slate-400 hover:bg-slate-100 transition active:scale-90"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveModal} className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">예약 루트</label>
                  <select
                    value={formSource}
                    onChange={(e) => setFormSource(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                  >
                    <option value="naver">네이버</option>
                    <option value="spacecloud">스페이스클라우드</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">공간 선택</label>
                  <select
                    value={formRoom}
                    onChange={(e) => setFormRoom(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                  >
                    <option value="머무룸1">머무룸1</option>
                    <option value="머무룸2">머무룸2</option>
                    <option value="머무룸3">머무룸3</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">예약자 성함</label>
                  <input
                    type="text"
                    required
                    lang="ko"
                    inputMode="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="김철수"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">전화번호 (선택)</label>
                  <input
                    type="tel"
                    placeholder="010-1234-5678"
                    value={formPhone}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "");
                      let formatted = digits;
                      if (digits.length > 3 && digits.length <= 7) {
                        formatted = `${digits.slice(0, 3)}-${digits.slice(3)}`;
                      } else if (digits.length > 7) {
                        formatted = `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
                      }
                      setFormPhone(formatted);
                    }}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">고객구분</label>
                  <select
                    value={customerType}
                    onChange={(e) => setCustomerType(e.target.value as CustomerType)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                  >
                    {Object.entries(CUSTOMER_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">예약 일자</label>
                
                {/* 선택된 날짜들을 개별 입력창으로 나열 (수정 모드일 때는 1개만) */}
                {formDates.map((date, index) => (
                  <div key={index} className="flex gap-2 mb-2">
                    <input
                      type="date"
                      required
                      value={date}
                      onChange={(e) => {
                        const newDates = [...formDates];
                        newDates[index] = e.target.value;
                        setFormDates(newDates);
                      }}
                      className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                    />
                    {modalMode !== "edit" && (
                      <button
                        type="button"
                        onClick={() => setFormDates(formDates.filter((_, i) => i !== index))}
                        className="p-2.5 rounded-xl bg-rose-50 text-rose-500 hover:bg-rose-100 transition flex items-center justify-center"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}

                {/* 다중 선택 달력 토글 버튼 (수정 모드가 아닐 때만) */}
                {modalMode !== "edit" && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowMultiPicker(!showMultiPicker)}
                      className="w-full text-xs font-bold py-2 bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition border border-dashed border-slate-300"
                    >
                      {showMultiPicker ? "닫기 ▲" : "+ 날짜 추가 (달력에서 다중 선택)"}
                    </button>
                    
                    {showMultiPicker && (
                      <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                        <MultiDatePicker 
                          selectedDates={formDates} 
                          onChange={setFormDates} 
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">시작 시간</label>
                  <TimeSelect value={formStartTime} onChange={setFormStartTime} maxHour={23} />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">종료 시간</label>
                  <TimeSelect value={formEndTime} onChange={setFormEndTime} maxHour={26} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">인원 수 (명)</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={formGuests}
                    onChange={(e) => setFormGuests(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">이용 목적 (대분류)</label>
                  <select
                    value={formPurpose}
                    onChange={(e) => setFormPurpose(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                  >
                    <option value="">미입력</option>
                    {MAJOR_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">세부내용 (선택 입력)</label>
                <input
                  type="text"
                  lang="ko"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={formDetail}
                  onChange={(e) => setFormDetail(e.target.value)}
                  placeholder="예: 보험교육, 유튜브 촬영"
                  className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">비고 (자유 입력)</label>
                <textarea
                  lang="ko"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="예약 관련 메모나 참고사항을 자유롭게 적어주세요."
                  rows={2}
                  className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">결제 가격 (원화)</label>
                  <input
                    type="text"
                    required
                    value={formPrice}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "");
                      if (!digits) setFormPrice("");
                      else setFormPrice(parseInt(digits, 10).toLocaleString());
                    }}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">쿠폰 및 할인 (원화)</label>
                  <input
                    type="text"
                    value={discount}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "");
                      if (!digits) setDiscount(0);
                      else setDiscount(parseInt(digits, 10));
                    }}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">결제 수단</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white"
                  >
                    <option value="현장카드">현장카드</option>
                    <option value="계좌이체">계좌이체</option>
                    <option value="온라인">온라인</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-rose-500">고객 불만사항 (CS 기록)</label>
                <textarea
                  lang="ko"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={complaints}
                  onChange={(e) => setComplaints(e.target.value)}
                  placeholder="고객 불만사항이 발생한 경우, 여기에 상세히 기록해 주세요."
                  rows={2}
                  className="w-full text-sm p-3 rounded-xl border border-rose-200 outline-hidden focus:border-rose-500 font-medium text-rose-900 bg-rose-50 resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* 결제 완료 여부 토글 */}
                <button
                  type="button"
                  onClick={() => setIsPaid(!isPaid)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border transition active:scale-[0.99] ${
                    isPaid
                      ? "bg-emerald-50 border-emerald-200"
                      : "bg-rose-50 border-rose-200"
                  }`}
                >
                  <span className="text-sm font-bold text-slate-700">결제 완료 여부</span>
                  <span className={`flex items-center gap-1.5 text-sm font-bold ${isPaid ? "text-emerald-600" : "text-rose-600"}`}>
                    <span className={`w-2 h-2 rounded-full ${isPaid ? "bg-emerald-500" : "bg-rose-500"}`} />
                    {isPaid ? "결제완료" : "미결제"}
                  </span>
                </button>

                {/* 정리 불량 여부 토글 */}
                <button
                  type="button"
                  onClick={() => setIsCleanUpBad(!isCleanUpBad)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border transition active:scale-[0.99] ${
                    isCleanUpBad
                      ? "bg-orange-50 border-orange-200"
                      : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <span className="text-sm font-bold text-slate-700">정리 상태 불량</span>
                  <span className={`flex items-center gap-1.5 text-sm font-bold ${isCleanUpBad ? "text-orange-600" : "text-slate-500"}`}>
                    {isCleanUpBad ? "🧹 체크됨" : "양호"}
                  </span>
                </button>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 text-sm rounded-xl hover:shadow-lg transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {isSubmitting ? "처리 중..." : modalMode === "edit" ? "수정 사항 저장" : modalMode === "copy" ? "여러 날짜에 복사하기" : "예약 생성 완료"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
