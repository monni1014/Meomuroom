"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Clock, User, Trash2, X, Wallet, RefreshCw, Copy, Pencil, Phone, Star, SprayCan, MessageSquareText, Binoculars } from "lucide-react";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { MAJOR_CATEGORIES, UNCATEGORIZED_LABEL } from "@/lib/categories";
import { CUSTOMER_TYPE_LABELS, normalizeCustomerType, type CustomerType } from "@/lib/customer-types";
import TimeSelect from "@/components/TimeSelect";
import MultiDatePicker from "@/components/MultiDatePicker";
import RpaStatusBadge from "@/components/RpaStatusBadge";
import { createKstDate, getKstDateParts } from "@/lib/kst-time";
import { useDataChangePolling } from "@/hooks/useDataChangePolling";
import { patchReservationWithNotificationConfirmation } from "@/lib/reservation-notification-resend-client";

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
  phoneLocked: boolean;
  startTime: string;
  endTime: string;
  timeLocked: boolean;
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
  visitorReviewRequested: boolean;
  blogReviewRequested: boolean;
  emailId: string | null; // null = 수기 입력 (메일 자동연동 아님)
  usageLog: UsageLog | null;
}

interface CleaningSchedule {
  id: string;
  roomName: string;
  roomNames: string[];
  cleanerName: string;
  scheduleType: "CLEANING" | "SITE_VISIT";
  contactPhone: string | null;
  source: "naver" | "spacecloud" | null;
  startTime: string;
  endTime: string;
  cost: number;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
}

type CalendarAgendaItem =
  | { kind: "reservation"; id: string; startTime: string; reservation: Reservation }
  | { kind: "cleaning"; id: string; startTime: string; cleaning: CleaningSchedule };

const ROOM_FILTERS = ["all", "머무룸1", "머무룸2", "머무룸3"] as const;
const CLEANING_ROOM_OPTIONS = ["머무룸1", "머무룸2", "머무룸3"] as const;
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

async function getCurrentPushSubscriptionEndpoint() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;

  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    return subscription?.endpoint || null;
  } catch (error) {
    console.warn("Current push subscription lookup failed:", error);
    return null;
  }
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

function formatCleaningRooms(roomNames: string[]) {
  return roomNames.length === CLEANING_ROOM_OPTIONS.length ? "전체 공간" : roomNames.join(" · ");
}

function getCleaningRoomTextStyle(roomName: string) {
  if (roomName === "머무룸1") return "text-sky-700";
  if (roomName === "머무룸2") return "text-purple-700";
  if (roomName === "머무룸3") return "text-orange-700";
  return "text-slate-600";
}

function getPaymentMethodDisplay(paymentMethod: string) {
  return paymentMethod === "현장카드" ? "카드" : paymentMethod;
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
  const [cleaningSchedules, setCleaningSchedules] = useState<CleaningSchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isScheduleTypeModalOpen, setIsScheduleTypeModalOpen] = useState(false);
  const [isCleaningModalOpen, setIsCleaningModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<RoomFilter>(initialRoomFilter);
  const [expandedReservationId, setExpandedReservationId] = useState<string | null>(null);
  const selectedDaySectionRef = useRef<HTMLElement>(null);

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
  const [formSource, setFormSource] = useState("manual"); // 예약 루트 (수기/네이버/스페이스클라우드)
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

  const [cleaningEditId, setCleaningEditId] = useState<string | null>(null);
  const [calendarScheduleType, setCalendarScheduleType] = useState<"CLEANING" | "SITE_VISIT">("CLEANING");
  const [cleaningRooms, setCleaningRooms] = useState<string[]>([]);
  const [cleanerName, setCleanerName] = useState("");
  const [siteVisitPhone, setSiteVisitPhone] = useState("");
  const [siteVisitSource, setSiteVisitSource] = useState<"naver" | "spacecloud" | "">("");
  const [cleaningDate, setCleaningDate] = useState(format(initialDate, "yyyy-MM-dd"));
  const [cleaningStartTime, setCleaningStartTime] = useState("09:00");
  const [cleaningEndTime, setCleaningEndTime] = useState("10:00");
  const [cleaningCost, setCleaningCost] = useState("0");
  const [cleaningMemo, setCleaningMemo] = useState("");
  const [isCleaningSubmitting, setIsCleaningSubmitting] = useState(false);

  const fetchReservations = useCallback(async () => {
    try {
      const [reservationResponse, cleaningResponse] = await Promise.all([
        fetch("/api/reservations"),
        fetch("/api/cleaning-schedules"),
      ]);
      if (reservationResponse.ok) setReservations(await reservationResponse.json());
      if (cleaningResponse.ok) setCleaningSchedules(await cleaningResponse.json());
    } catch (err) {
      console.error("Failed to load calendar data:", err);
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

  const selectCalendarDay = (day: Date) => {
    setSelectedDate(day);
    replaceCalendarState(day, roomFilter);

    if (window.matchMedia("(max-width: 639px)").matches) {
      window.requestAnimationFrame(() => {
        selectedDaySectionRef.current?.scrollIntoView({
          behavior: "auto",
          block: "start",
        });
      });
    }
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

  const filteredCleaningSchedules = roomFilter === "all"
    ? cleaningSchedules
    : cleaningSchedules.filter((schedule) => schedule.roomNames.includes(roomFilter));

  const selectedReservations = filteredReservations
    .filter((res) => isSameDay(new Date(res.startTime), selectedDate))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const selectedDayRevenue = selectedReservations.reduce(
    (sum, reservation) => sum + (reservation.price || 0),
    0,
  );
  const selectedCleaningSchedules = filteredCleaningSchedules
    .filter((schedule) => isSameDay(new Date(schedule.startTime), selectedDate))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const selectedAgendaItems: CalendarAgendaItem[] = [
    ...selectedReservations.map((reservation) => ({
      kind: "reservation" as const,
      id: reservation.id,
      startTime: reservation.startTime,
      reservation,
    })),
    ...selectedCleaningSchedules.map((cleaning) => ({
      kind: "cleaning" as const,
      id: cleaning.id,
      startTime: cleaning.startTime,
      cleaning,
    })),
  ].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

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
        const res = await patchReservationWithNotificationConfirmation(
          editId,
          buildPayload(formDates[0]),
        );
        if (!res.ok) throw new Error("수정 실패");
      } else {
        const pushSubscriptionEndpoint = await getCurrentPushSubscriptionEndpoint();
        const promises = formDates.map((dateStr) =>
          fetch("/api/reservations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...buildPayload(dateStr),
              pushSubscriptionEndpoint,
            }),
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
      setFormSource("manual");
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
    setFormSource(["manual", "naver", "spacecloud"].includes(res.source) ? res.source : "manual");
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

  const resetCleaningForm = (
    date = selectedDate,
    scheduleType: "CLEANING" | "SITE_VISIT" = "CLEANING",
  ) => {
    setCleaningEditId(null);
    setCalendarScheduleType(scheduleType);
    setCleaningRooms([]);
    setCleanerName("");
    setSiteVisitPhone("");
    setSiteVisitSource("");
    setCleaningDate(format(date, "yyyy-MM-dd"));
    setCleaningStartTime("09:00");
    setCleaningEndTime("10:00");
    setCleaningCost("0");
    setCleaningMemo("");
  };

  const openCleaningCreateModal = (scheduleType: "CLEANING" | "SITE_VISIT") => {
    resetCleaningForm(selectedDate, scheduleType);
    setIsScheduleTypeModalOpen(false);
    setIsCleaningModalOpen(true);
  };

  const openCleaningEditModal = (schedule: CleaningSchedule) => {
    const start = new Date(schedule.startTime);
    const end = new Date(schedule.endTime);
    const startParts = getKstDateParts(start);
    const clock = (parts: ReturnType<typeof getKstDateParts>) =>
      `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;

    setCleaningEditId(schedule.id);
    setCalendarScheduleType(schedule.scheduleType || "CLEANING");
    setCleaningRooms(schedule.roomNames);
    setCleanerName(schedule.cleanerName);
    setSiteVisitPhone(schedule.contactPhone || "");
    setSiteVisitSource(schedule.source || "");
    setCleaningDate(format(start, "yyyy-MM-dd"));
    setCleaningStartTime(clock(startParts));
    setCleaningEndTime(extendedEndClock(start, end));
    setCleaningCost(schedule.cost.toLocaleString("ko-KR"));
    setCleaningMemo(schedule.memo || "");
    setIsCleaningModalOpen(true);
  };

  const handleSaveCleaning = async (event: React.FormEvent) => {
    event.preventDefault();
    const isSiteVisit = calendarScheduleType === "SITE_VISIT";
    if (!cleanerName.trim()) return alert(`${isSiteVisit ? "방문자 이름" : "청소한 사람"}을 입력해 주세요.`);
    if (cleaningRooms.length === 0) return alert(`${isSiteVisit ? "사전답사할" : "청소할"} 공간을 하나 이상 선택해 주세요.`);
    if (isSiteVisit && !/^01[016789]-?\d{3,4}-?\d{4}$/.test(siteVisitPhone.trim())) {
      return alert("사전답사 연락처를 올바르게 입력해 주세요.");
    }
    if (isSiteVisit && !siteVisitSource) return alert("사전답사 유입 경로를 선택해 주세요.");

    const normalizedEndTime = normalizeEndClock(cleaningStartTime, cleaningEndTime);
    const startMinutes = parseClockMinutes(cleaningStartTime);
    const endMinutes = parseClockMinutes(normalizedEndTime);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      return alert(`${isSiteVisit ? "사전답사" : "청소"} 종료 시간은 시작 시간보다 늦어야 합니다.`);
    }

    const payload = {
      roomNames: cleaningRooms,
      cleanerName: cleanerName.trim(),
      scheduleType: calendarScheduleType,
      contactPhone: isSiteVisit ? siteVisitPhone.trim() : null,
      source: isSiteVisit ? siteVisitSource : null,
      startTime: buildLocalDateTime(cleaningDate, cleaningStartTime).toISOString(),
      endTime: buildLocalDateTime(cleaningDate, normalizedEndTime).toISOString(),
      cost: isSiteVisit ? 0 : Number(cleaningCost.replace(/,/g, "")) || 0,
      memo: cleaningMemo.trim() || null,
    };

    try {
      setIsCleaningSubmitting(true);
      const response = await fetch(
        cleaningEditId ? `/api/cleaning-schedules/${cleaningEditId}` : "/api/cleaning-schedules",
        {
          method: cleaningEditId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `${isSiteVisit ? "사전답사" : "청소"} 일정 저장 실패`);

      setIsCleaningModalOpen(false);
      await fetchReservations();
    } catch (error) {
      console.error("Save calendar schedule error:", error);
      alert(error instanceof Error ? error.message : "일정 저장에 실패했습니다.");
    } finally {
      setIsCleaningSubmitting(false);
    }
  };

  const handleDeleteCleaning = async (schedule: CleaningSchedule) => {
    const label = schedule.scheduleType === "SITE_VISIT" ? "사전답사" : "청소";
    if (!confirm(`이 ${label} 일정을 삭제할까요?`)) return;

    try {
      const response = await fetch(`/api/cleaning-schedules/${schedule.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`${label} 일정 삭제 실패`);
      await fetchReservations();
    } catch (error) {
      console.error("Delete cleaning schedule error:", error);
      alert(`${label} 일정을 삭제하지 못했습니다.`);
    }
  };

  const getSourceDisplay = (source: string) => {
    switch (source) {
      case "naver":
        return "네이버";
      case "spacecloud":
        return "스클";
      case "direct":
        return "직접";
      default:
        return "직접";
    }
  };

  const getSourceBadgeStyle = (source: string) => {
    switch (source) {
      case "naver":
        return "text-slate-500";
      case "spacecloud":
        return "text-slate-500";
      default:
        return "text-slate-500";
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

  const getRoomCalendarStyle = (room: string, isCancelled: boolean) => {
    const cancelledStyle = isCancelled ? " line-through" : "";
    switch (room) {
      case "머무룸1":
        return `bg-sky-100 text-sky-800${cancelledStyle}`;
      case "머무룸2":
        return `bg-purple-100 text-purple-800${cancelledStyle}`;
      case "머무룸3":
        return `bg-orange-200 text-orange-900${cancelledStyle}`;
      default:
        return `bg-slate-100 text-slate-700${cancelledStyle}`;
    }
  };

  const getSourceAccentStyle = (source: string, isCancelled: boolean) => {
    if (isCancelled) return "border-l-slate-300";
    if (source === "naver") return "border-l-green-500";
    if (source === "spacecloud") return "border-l-indigo-500";
    return "border-l-amber-500";
  };

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-7xl mx-auto w-full">
      <header className="pt-8 pb-4 flex justify-between items-start gap-3 flex-wrap sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">통합 캘린더</h1>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
          <button
            onClick={handleSyncEmails}
            disabled={isSyncing}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl shadow-md text-sm font-bold transition-all active:scale-95 whitespace-nowrap",
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
            className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl shadow-md hover:bg-indigo-700 active:scale-95 transition-all whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            수동 예약 추가
          </button>
          <button
            onClick={() => setIsScheduleTypeModalOpen(true)}
            className="col-span-2 flex items-center justify-center gap-1.5 px-3.5 py-2.5 bg-amber-400 text-amber-950 text-sm font-bold rounded-xl shadow-md hover:bg-amber-500 active:scale-95 transition-all whitespace-nowrap sm:col-span-1"
          >
            <SprayCan className="w-4 h-4" />
            청소/사전답사 일정 추가
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
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {ROOM_FILTERS.map((room) => (
          <button
            key={room}
            onClick={() => {
              setRoomFilter(room);
              replaceCalendarState(selectedDate, room);
            }}
            className={cn(
              "shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-all active:scale-95 border",
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
        <div className="flex justify-between items-center mb-4 sm:mb-6">
          <button onClick={prevMonth} className="p-1 rounded-full hover:bg-slate-50 active:scale-95 transition-all">
            <ChevronLeft className="w-6 h-6 text-slate-600" />
          </button>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 sm:text-lg">
              {format(currentDate, "yyyy년 M월")}
            </h2>
            <button
              onClick={() => {
                const today = new Date();
                setCurrentDate(today);
                setSelectedDate(today);
                replaceCalendarState(today, roomFilter);
              }}
              className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-200"
            >
              오늘
            </button>
          </div>
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
            const dayReservations = filteredReservations
              .filter((res) => isSameDay(new Date(res.startTime), day))
              .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
            const dayCleaningSchedules = filteredCleaningSchedules
              .filter((schedule) => isSameDay(new Date(schedule.startTime), day))
              .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
            const dayAgendaItems: CalendarAgendaItem[] = [
              ...dayReservations.map((reservation) => ({
                kind: "reservation" as const,
                id: reservation.id,
                startTime: reservation.startTime,
                reservation,
              })),
              ...dayCleaningSchedules.map((cleaning) => ({
                kind: "cleaning" as const,
                id: cleaning.id,
                startTime: cleaning.startTime,
                cleaning,
              })),
            ].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
            
            const hasUnpaid = dayReservations.some((res) => !res.isPaid && res.status !== "CANCELLED");
            const hasUnpaidExtra = dayReservations.some((res) => res.usageLog && (res.usageLog.extraPrice ?? 0) > 0 && !res.usageLog.isExtraPaid && res.status !== "CANCELLED");

            return (
              <button
                key={day.toISOString()}
                onClick={() => selectCalendarDay(day)}
                className={cn(
                  "flex min-h-[72px] flex-col items-stretch rounded-lg p-0.5 relative transition-all active:scale-95 sm:min-h-[55px] sm:items-center sm:justify-between sm:rounded-xl sm:p-1.5",
                  isSelected
                    ? "bg-indigo-50 text-indigo-800 sm:bg-[#d6ddff] sm:text-indigo-900"
                    : "hover:bg-slate-50 text-slate-700",
                  isToday
                    ? "ring-2 ring-inset ring-orange-500"
                    : isSelected && "ring-2 ring-inset ring-indigo-500",
                  isSelected && "sm:shadow-md sm:shadow-indigo-100",
                  !isSameMonthOfActive && "opacity-30"
                )}
              >
                <div className="relative inline-flex w-fit self-center items-center justify-center">
                  <span data-testid="calendar-day-number" className={cn("text-sm font-semibold", (day.getDay() === 0 || day.getDay() === 6) && !isSelected && "text-rose-500")}>
                    {format(day, "d")}
                  </span>
                  {(hasUnpaid || hasUnpaidExtra) && (
                    <div data-testid="calendar-day-unpaid-stars" className="absolute -top-1 left-full ml-0.5 flex gap-0.5" title="미결제/미수금 예약 있음">
                      {hasUnpaid && <Star className="w-2.5 h-2.5 text-amber-500 fill-amber-400 drop-shadow-sm" />}
                      {hasUnpaidExtra && <Star className="w-2.5 h-2.5 text-red-500 fill-red-500 drop-shadow-sm animate-pulse" />}
                    </div>
                  )}
                </div>
                
                {/* 모바일은 타임트리처럼 일정 내용을, 넓은 화면은 기존 점 표시를 사용 */}
                <div data-testid="mobile-month-events" className="mt-1 flex min-w-0 flex-col gap-0.5 sm:hidden">
                  {dayAgendaItems.slice(0, 2).map((agendaItem) => {
                    const startParts = getKstDateParts(new Date(agendaItem.startTime));
                    const clock = `${String(startParts.hour).padStart(2, "0")}:${String(startParts.minute).padStart(2, "0")}`;
                    const compactClock = startParts.minute === 0
                      ? String(startParts.hour)
                      : `${startParts.hour}:${String(startParts.minute).padStart(2, "0")}`;
                    if (agendaItem.kind === "cleaning") {
                      const isSiteVisit = agendaItem.cleaning.scheduleType === "SITE_VISIT";
                      return (
                        <span
                          key={`cleaning-${agendaItem.id}`}
                          className={cn(
                            "block min-w-0 truncate rounded border border-dashed px-0.5 py-0.5 text-left text-[8px] font-bold leading-none tracking-tight",
                            isSiteVisit
                              ? "border-sky-400 bg-sky-100 text-sky-900"
                              : "border-amber-400 bg-amber-100 text-amber-950",
                          )}
                          title={`${clock} ${formatCleaningRooms(agendaItem.cleaning.roomNames)} ${isSiteVisit ? "사전답사" : "청소"} · ${agendaItem.cleaning.cleanerName}`}
                        >
                          {compactClock} {isSiteVisit ? "답사" : "청소"}
                        </span>
                      );
                    }
                    const res = agendaItem.reservation;
                    const isCancelled = res.status === "CANCELLED";
                    return (
                      <span
                        key={`reservation-${res.id}`}
                        className={cn(
                          "block min-w-0 truncate rounded px-0.5 py-0.5 text-left text-[8px] font-bold leading-none tracking-tight",
                          getRoomCalendarStyle(res.roomName, isCancelled)
                        )}
                        title={`${clock} ${res.roomName} ${res.customerName ?? "이름 미확인"}`}
                      >
                        {compactClock} {res.customerName ?? "미확인"}
                      </span>
                    );
                  })}
                  {dayAgendaItems.length > 2 && (
                    <span className="px-1 text-left text-[9px] font-bold leading-none text-slate-400">
                      +{dayAgendaItems.length - 2}건
                    </span>
                  )}
                </div>

                <div className="mt-1 hidden h-2 justify-center gap-0.5 sm:flex">
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
                          dotClass
                        )}
                      />
                    );
                  })}
                  {dayCleaningSchedules.map((schedule) => (
                    <span
                      key={`cleaning-${schedule.id}`}
                      className={cn(
                        "h-1.5 w-1.5 rounded-xs ring-1",
                        schedule.scheduleType === "SITE_VISIT"
                          ? "bg-sky-400 ring-sky-600"
                          : "bg-amber-400 ring-amber-600",
                      )}
                      title={`${schedule.cleanerName} ${schedule.scheduleType === "SITE_VISIT" ? "사전답사" : "청소"}`}
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Selected Day Reservations List */}
      <section ref={selectedDaySectionRef} className="scroll-mt-4 bg-white rounded-2xl shadow-sm border border-slate-100 p-4 space-y-4">
        <div className="flex justify-between items-center pb-2 border-b border-slate-50">
          <h3 className="text-sm font-bold text-slate-800">
            {format(selectedDate, "M월 d일")} 일정 ({selectedAgendaItems.length}건)
          </h3>
          <span className="whitespace-nowrap text-xs font-semibold text-slate-500">
            하루 총 매출{" "}
            <strong className="text-sm font-black tabular-nums text-slate-950">
              {selectedDayRevenue.toLocaleString("ko-KR")}원
            </strong>
          </span>
        </div>

        <div className="space-y-3">
          {isLoading ? (
            <div className="text-center py-6 text-slate-400 text-xs">일정 데이터를 불러오는 중...</div>
          ) : selectedAgendaItems.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              이날 잡힌 일정이 없습니다.
            </div>
          ) : (
            selectedAgendaItems.map((agendaItem) => {
              if (agendaItem.kind === "cleaning") {
                const schedule = agendaItem.cleaning;
                const isSiteVisit = schedule.scheduleType === "SITE_VISIT";
                const start = new Date(schedule.startTime);
                const end = new Date(schedule.endTime);
                const startClock = `${String(getKstDateParts(start).hour).padStart(2, "0")}:${String(getKstDateParts(start).minute).padStart(2, "0")}`;
                const displayEndTime = extendedEndClock(start, end);

                return (
                  <div
                    key={`cleaning-${schedule.id}`}
                    data-testid={isSiteVisit ? "site-visit-agenda-card" : "cleaning-agenda-card"}
                    className={cn(
                      "relative flex items-center gap-2 rounded-xl border-2 border-dashed p-3 md:gap-3 md:p-4",
                      isSiteVisit
                        ? "border-sky-400 bg-sky-50/90"
                        : "border-amber-400 bg-amber-50/90",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2 md:gap-3">
                      <div className="w-[58px] shrink-0 text-center">
                        <strong className="block text-sm text-slate-900">{startClock}</strong>
                        <span className="text-[10px] font-medium text-slate-400">~ {displayEndTime}</span>
                      </div>
                      <div className="min-w-0 flex-1 space-y-1 md:space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold",
                            isSiteVisit ? "bg-sky-500 text-white" : "bg-amber-400 text-amber-950",
                          )}>
                            {isSiteVisit ? <Binoculars className="h-3 w-3" /> : <SprayCan className="h-3 w-3" />}
                            <span className="md:hidden">{isSiteVisit ? "답사" : "청소"}</span>
                            <span className="hidden md:inline">{isSiteVisit ? "사전답사" : "청소 일정"}</span>
                          </span>
                          {isSiteVisit && schedule.source && (
                            <span className={cn(
                              "rounded border px-1.5 py-0.5 text-[10px] font-bold",
                              schedule.source === "naver"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-indigo-200 bg-indigo-50 text-indigo-700",
                            )}>
                              {getSourceDisplay(schedule.source)}
                            </span>
                          )}
                          {(schedule.roomNames.length === CLEANING_ROOM_OPTIONS.length
                            ? ["전체 공간"]
                            : schedule.roomNames
                          ).map((roomName) => (
                            <span
                              key={roomName}
                              className={cn(
                                "rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold",
                                getCleaningRoomTextStyle(roomName),
                              )}
                            >
                              {roomName}
                            </span>
                          ))}
                          <strong className="hidden min-w-0 truncate text-sm text-slate-900 md:block">{schedule.cleanerName}</strong>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <strong className="min-w-0 truncate text-slate-900 md:hidden">{schedule.cleanerName}</strong>
                          {isSiteVisit ? (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5" /> {schedule.contactPhone}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <Wallet className="h-3.5 w-3.5" /> 비용 <strong className="text-slate-800">{schedule.cost.toLocaleString("ko-KR")}원</strong>
                            </span>
                          )}
                        </div>
                        {schedule.memo && (
                          <p className="truncate text-xs text-slate-500 md:whitespace-pre-wrap">{schedule.memo}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 justify-end gap-0 md:gap-1">
                      <button
                        onClick={() => openCleaningEditModal(schedule)}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white hover:text-teal-600 active:scale-95 md:p-2"
                        title={`${isSiteVisit ? "사전답사" : "청소"} 일정 수정`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteCleaning(schedule)}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 active:scale-95 md:p-2"
                        title={`${isSiteVisit ? "사전답사" : "청소"} 일정 삭제`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              }

              const res = agendaItem.reservation;
              const start = new Date(res.startTime);
              const end = new Date(res.endTime);
              const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
              const displayEndTime = extendedEndClock(start, end);
              const isCancelled = res.status === "CANCELLED";
              const isExpanded = expandedReservationId === res.id;
              const headCount = res.usageLog?.headCount || 1;
              const hasUnpaid = !isCancelled && !res.isPaid;
              const hasUnpaidExtra = !isCancelled
                && (res.usageLog?.extraPrice ?? 0) > 0
                && !res.usageLog?.isExtraPaid;
              const hasReviewRequest = !isCancelled
                && (res.visitorReviewRequested || res.blogReviewRequested);

              return (
                <div
                  key={res.id}
                  data-testid="mobile-agenda-card"
                  aria-expanded={isExpanded}
                  onClick={(event) => {
                    if (isExpanded && (event.target as HTMLElement).closest('[data-agenda-detail="true"]')) return;
                    setExpandedReservationId(isExpanded ? null : res.id);
                  }}
                  onDoubleClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']")) return;
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
                    "relative flex flex-col gap-3 rounded-xl border border-l-4 p-3 cursor-pointer select-none sm:p-4 md:flex-row md:items-start md:justify-between md:gap-2",
                    isCancelled ? "bg-slate-100 border-slate-200" : "bg-slate-50 border-slate-100",
                    getSourceAccentStyle(res.source, isCancelled)
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3 md:hidden">
                    <div className="w-[58px] shrink-0 text-center">
                      <strong className={cn("block text-sm", isCancelled ? "text-slate-400 line-through" : "text-slate-900")}>{formatTime(start)}</strong>
                      <span className="text-[10px] font-medium text-slate-400">~ {displayEndTime}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold", getRoomCalendarStyle(res.roomName, isCancelled))}>
                          {res.roomName}
                        </span>
                        <span className="relative min-w-0 pr-2">
                          <strong className={cn("block min-w-0 truncate text-sm", isCancelled ? "text-slate-500 line-through" : "text-slate-900")}>
                            {res.customerName ?? "이름 미확인"}
                          </strong>
                          {hasReviewRequest && (
                            <MessageSquareText
                              data-testid="calendar-review-badge"
                              className="absolute -right-0.5 -top-1 h-2.5 w-2.5 text-slate-700"
                              aria-label="리뷰 이벤트 신청"
                            />
                          )}
                        </span>
                        {!isCancelled && !res.isPaid && (
                          <span className="shrink-0 text-[11px] font-bold text-rose-600">미수</span>
                        )}
                        {(hasUnpaid || hasUnpaidExtra) && (
                          <span className="flex shrink-0 items-center gap-0.5" aria-label="미결제 상태">
                            {hasUnpaid && (
                              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500 drop-shadow-sm" aria-label="예약금 미수" />
                            )}
                            {hasUnpaidExtra && (
                              <Star className="h-3.5 w-3.5 fill-red-500 text-red-500 drop-shadow-sm" aria-label="추가금 미결제" />
                            )}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] text-slate-500">
                        <span className={cn("shrink-0 text-[11px] font-medium", getSourceBadgeStyle(res.source))}>
                          {getSourceDisplay(res.source)}
                        </span>
                        {!isCancelled && res.paymentMethod && (
                          <span className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                            res.isPaid
                              ? "border-slate-200 bg-slate-100 text-slate-600"
                              : "border-rose-300 bg-rose-50 text-rose-600"
                          )}>
                            {getPaymentMethodDisplay(res.paymentMethod)}
                          </span>
                        )}
                        <span>·</span>
                        <span>{headCount}명</span>
                        {res.price > 0 && <><span>·</span><span>{res.price.toLocaleString()}원</span></>}
                        {isCancelled && <span className="font-bold text-slate-500">· 취소</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform", isExpanded && "rotate-180")} />
                    </div>
                  </div>

                  <div
                    data-agenda-detail="true"
                    className={cn("min-w-0 flex-1 space-y-3", !isExpanded && "hidden md:block")}
                  >
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
                      <span className={cn("hidden text-[11px] font-medium md:inline-flex", getSourceBadgeStyle(res.source))}>
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
                      <span className={cn("hidden px-1.5 py-0.5 rounded text-[10px] font-semibold md:inline-flex", getRoomBadgeStyle(res.roomName))}>
                        {res.roomName}
                      </span>
                      <span className="relative hidden pr-2 md:inline-flex">
                        <strong className={cn("text-sm", isCancelled ? "text-slate-500 line-through" : "text-slate-900")}>
                          {res.customerName}
                        </strong>
                        {hasReviewRequest && (
                          <MessageSquareText
                            data-testid="calendar-review-badge"
                            className="absolute -right-0.5 -top-1 h-2.5 w-2.5 text-slate-700"
                            aria-label="리뷰 이벤트 신청"
                          />
                        )}
                      </span>
                      {(hasUnpaid || hasUnpaidExtra) && (
                        <span className="hidden items-center gap-0.5 md:inline-flex" aria-label="미결제 상태">
                          {hasUnpaid && (
                            <Star className="h-3 w-3 fill-amber-400 text-amber-500 drop-shadow-sm" aria-label="예약금 미수" />
                          )}
                          {hasUnpaidExtra && (
                            <Star className="h-3 w-3 fill-red-500 text-red-500 drop-shadow-sm" aria-label="추가금 미결제" />
                          )}
                        </span>
                      )}
                      {!isCancelled && res.paymentMethod && (
                        <span className={cn(
                          "hidden px-1.5 py-0.5 rounded text-[10px] font-semibold border md:inline-flex",
                          res.isPaid 
                            ? "bg-slate-100 text-slate-600 border-slate-200" 
                            : "bg-rose-50 text-rose-600 border-rose-300 shadow-sm shadow-rose-100"
                        )}>
                          {getPaymentMethodDisplay(res.paymentMethod)}{!res.isPaid && "(미수)"}
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

                    <div className="grid grid-cols-1 gap-2 text-xs text-slate-500 sm:grid-cols-2 sm:gap-x-4 sm:gap-y-1">
                      <p className="flex min-w-0 items-center gap-1">
                        <Clock className="h-3.5 w-3.5 shrink-0" />
                        <span>{formatTime(start)} - {displayEndTime} ({formatDuration(start, end)})</span>
                        {res.timeLocked && (
                          <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold text-orange-700 ring-1 ring-orange-200">
                            수동시간 고정
                          </span>
                        )}
                      </p>
                      <p className="flex min-w-0 items-start gap-1">
                        <User className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>인원: {res.usageLog?.headCount || 1}명 ({res.usageLog?.purpose || UNCATEGORIZED_LABEL}{res.usageLog?.detail ? ` · ${res.usageLog.detail}` : ""})</span>
                      </p>
                      {res.price > 0 && (
                        <p className="flex min-w-0 items-center gap-1 text-slate-700">
                          <Wallet className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          <span>{isCancelled ? "수수료" : "요금"}: <strong className="text-slate-800">{res.price.toLocaleString()}원</strong></span>
                        </p>
                      )}
                      {res.phone && (
                        <p className="flex min-w-0 items-center gap-1">
                          <Phone className="h-3.5 w-3.5 shrink-0" />
                          <span className={cn(isCancelled ? "line-through text-slate-400" : "")}>{res.phone}</span>
                          {res.phoneLocked && (
                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-amber-200">
                              수동번호 고정
                            </span>
                          )}
                        </p>
                      )}
                      {!isCancelled && res.discount > 0 && (
                        <p className="flex min-w-0 items-center gap-1 text-rose-600">
                          <span>🎟️ 쿠폰 사용: -{res.discount.toLocaleString()}원</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className={cn(
                    "w-full flex-col items-end gap-2 border-t border-slate-200 pt-3 md:w-auto md:border-t-0 md:pt-5",
                    isExpanded ? "flex" : "hidden md:flex"
                  )} data-agenda-detail="true">
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
                        onClick={(e) => { e.stopPropagation(); handleMarkPaid(res.id); }}
                        className="px-2.5 py-1.5 text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition active:scale-95 whitespace-nowrap"
                        title="결제완료로 변경"
                      >
                        결제완료 처리
                      </button>
                    )}
                    <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto sm:flex-nowrap">
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
                    <option value="manual">수기</option>
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
                    <option value="현장카드">카드</option>
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

      {isScheduleTypeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 p-4">
              <h2 className="font-bold text-slate-800">추가할 일정 선택</h2>
              <button
                type="button"
                onClick={() => setIsScheduleTypeModalOpen(false)}
                className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 active:scale-90"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <button
                type="button"
                onClick={() => openCleaningCreateModal("CLEANING")}
                className="flex flex-col items-center gap-2 rounded-2xl border-2 border-amber-200 bg-amber-50 p-5 font-bold text-amber-950 transition hover:border-amber-400 active:scale-95"
              >
                <SprayCan className="h-7 w-7 text-amber-600" />
                청소
              </button>
              <button
                type="button"
                onClick={() => openCleaningCreateModal("SITE_VISIT")}
                className="flex flex-col items-center gap-2 rounded-2xl border-2 border-sky-200 bg-sky-50 p-5 font-bold text-sky-900 transition hover:border-sky-400 active:scale-95"
              >
                <Binoculars className="h-7 w-7 text-sky-600" />
                사전답사
              </button>
            </div>
          </div>
        </div>
      )}

      {isCleaningModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className={cn(
              "flex items-center justify-between border-b border-slate-100 p-4",
              calendarScheduleType === "SITE_VISIT" ? "bg-sky-50" : "bg-teal-50",
            )}>
              <h2 className="flex items-center gap-2 font-bold text-slate-800">
                {calendarScheduleType === "SITE_VISIT"
                  ? <Binoculars className="h-5 w-5 text-sky-600" />
                  : <SprayCan className="h-5 w-5 text-teal-600" />}
                {cleaningEditId
                  ? `${calendarScheduleType === "SITE_VISIT" ? "사전답사" : "청소"} 일정 수정`
                  : `새 ${calendarScheduleType === "SITE_VISIT" ? "사전답사" : "청소"} 일정 추가`}
              </h2>
              <button
                type="button"
                onClick={() => setIsCleaningModalOpen(false)}
                className="rounded-full p-1 text-slate-400 transition hover:bg-white active:scale-90"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCleaning} className="max-h-[75vh] space-y-4 overflow-y-auto p-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-500">
                  {calendarScheduleType === "SITE_VISIT" ? "답사 공간" : "청소 공간"} (중복 선택 가능)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {CLEANING_ROOM_OPTIONS.map((roomName) => {
                    const isChecked = cleaningRooms.includes(roomName);
                    return (
                      <label
                        key={roomName}
                        className={cn(
                          "flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-bold transition",
                          isChecked
                            ? calendarScheduleType === "SITE_VISIT"
                              ? "border-sky-500 bg-sky-50 text-sky-700"
                              : "border-teal-500 bg-teal-50 text-teal-700"
                            : calendarScheduleType === "SITE_VISIT"
                              ? "border-slate-200 bg-white text-slate-500 hover:border-sky-300"
                              : "border-slate-200 bg-white text-slate-500 hover:border-teal-300",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(event) => {
                            setCleaningRooms((current) =>
                              event.target.checked
                                ? CLEANING_ROOM_OPTIONS.filter((room) => current.includes(room) || room === roomName)
                                : current.filter((room) => room !== roomName),
                            );
                          }}
                          className={cn("h-4 w-4", calendarScheduleType === "SITE_VISIT" ? "accent-sky-600" : "accent-teal-600")}
                        />
                        {roomName}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">
                  {calendarScheduleType === "SITE_VISIT" ? "방문자 이름" : "청소한 사람"}
                </label>
                <input
                  type="text"
                  required
                  value={cleanerName}
                  onChange={(event) => setCleanerName(event.target.value)}
                  placeholder="이름 입력"
                  className={cn(
                    "w-full rounded-xl border border-slate-200 p-2.5 text-sm font-medium outline-hidden",
                    calendarScheduleType === "SITE_VISIT" ? "focus:border-sky-500" : "focus:border-teal-500",
                  )}
                />
              </div>

              {calendarScheduleType === "SITE_VISIT" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500">연락처</label>
                    <input
                      type="tel"
                      required
                      inputMode="tel"
                      value={siteVisitPhone}
                      onChange={(event) => setSiteVisitPhone(event.target.value)}
                      placeholder="010-0000-0000"
                      className="w-full rounded-xl border border-slate-200 p-2.5 text-sm font-medium outline-hidden focus:border-sky-500"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500">유입 경로</label>
                    <div className="grid grid-cols-2 gap-2">
                      {(["naver", "spacecloud"] as const).map((source) => (
                        <button
                          key={source}
                          type="button"
                          onClick={() => setSiteVisitSource(source)}
                          className={cn(
                            "rounded-xl border px-3 py-2.5 text-xs font-bold transition active:scale-95",
                            siteVisitSource === source
                              ? source === "naver"
                                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                : "border-indigo-500 bg-indigo-50 text-indigo-700"
                              : "border-slate-200 bg-white text-slate-500",
                          )}
                        >
                          {source === "naver" ? "네이버" : "스페이스클라우드"}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">
                  {calendarScheduleType === "SITE_VISIT" ? "답사 날짜" : "청소 날짜"}
                </label>
                <input
                  type="date"
                  required
                  value={cleaningDate}
                  onChange={(event) => setCleaningDate(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white p-2.5 text-sm font-medium outline-hidden focus:border-teal-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">시작 시간</label>
                  <TimeSelect value={cleaningStartTime} onChange={setCleaningStartTime} maxHour={23} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500">종료 시간</label>
                  <TimeSelect value={cleaningEndTime} onChange={setCleaningEndTime} maxHour={24} />
                </div>
              </div>

              {calendarScheduleType === "CLEANING" && <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">청소 비용</label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    value={cleaningCost}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "");
                      setCleaningCost(digits ? Number(digits).toLocaleString("ko-KR") : "");
                    }}
                    placeholder="0"
                    className="w-full rounded-xl border border-slate-200 py-2.5 pl-3 pr-9 text-sm font-medium outline-hidden focus:border-teal-500"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">원</span>
                </div>
              </div>}

              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500">메모 (선택)</label>
                <textarea
                  value={cleaningMemo}
                  onChange={(event) => setCleaningMemo(event.target.value)}
                  rows={3}
                  placeholder={calendarScheduleType === "SITE_VISIT" ? "방문 목적이나 특이사항" : "청소 범위나 특이사항"}
                  className="w-full resize-y rounded-xl border border-slate-200 p-2.5 text-sm font-medium outline-hidden focus:border-teal-500"
                />
              </div>

              <button
                type="submit"
                disabled={isCleaningSubmitting}
                className={cn(
                  "w-full rounded-xl py-3 text-sm font-bold text-white transition-all hover:shadow-lg active:scale-[0.98] disabled:opacity-50",
                  calendarScheduleType === "SITE_VISIT"
                    ? "bg-sky-600 hover:bg-sky-700"
                    : "bg-teal-600 hover:bg-teal-700",
                )}
              >
                {isCleaningSubmitting
                  ? "저장 중..."
                  : cleaningEditId
                    ? "수정 사항 저장"
                    : `${calendarScheduleType === "SITE_VISIT" ? "사전답사" : "청소"} 일정 저장`}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
