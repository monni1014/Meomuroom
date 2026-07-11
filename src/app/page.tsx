import { Calendar, Users, TrendingUp, Clock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import EmailSyncButton from "./EmailSyncButton";
import AutoRefresh from "./AutoRefresh";
import MonthlyReservationsList from "@/components/MonthlyReservationsList";
import TodayReservationsList from "@/components/TodayReservationsList";
import WeekFilter from "@/components/WeekFilter";
import MonthFilter from "@/components/MonthFilter";
import DismissibleAdminAlerts from "@/components/DismissibleAdminAlerts";

export const dynamic = "force-dynamic";

const SERVICE_START_MONTH = new Date(2025, 7, 1); // 2025년 8월
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseMonthParam(value: string | undefined, fallback: Date) {
  const match = value?.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

function parseDateParam(value: string | undefined) {
  const match = value?.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfWeekMonday(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay();
  result.setDate(result.getDate() - day + (day === 0 ? -6 : 1));
  return result;
}

function maxDate(a: Date, b: Date) {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date) {
  return a.getTime() <= b.getTime() ? a : b;
}

function buildMonthOptions(start: Date, end: Date, selected: Date) {
  const rangeStart = new Date(Math.min(start.getTime(), selected.getTime()));
  const rangeEnd = new Date(Math.max(end.getTime(), selected.getTime()));
  const current = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  const last = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
  const options: { value: string; label: string }[] = [];

  while (current <= last) {
    options.push({
      value: monthKey(current),
      label: `${current.getFullYear()}년 ${current.getMonth() + 1}월`,
    });
    current.setMonth(current.getMonth() + 1);
  }

  return options;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function DashboardPage(props: { searchParams?: Promise<any> | any }) {
  const searchParams = await Promise.resolve(props.searchParams || {});
  const weekStartParam = searchParams.weekStart as string | undefined;
  const monthParam = searchParams.month as string | undefined;

  // Get current date boundaries for Today
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const currentMonthStart = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
  const selectedMonthStart = parseMonthParam(monthParam, currentMonthStart);
  const selectedMonthEnd = new Date(selectedMonthStart.getFullYear(), selectedMonthStart.getMonth() + 1, 0, 23, 59, 59, 999);
  const selectedMonthKey = monthKey(selectedMonthStart);
  const selectedMonthLabel = `${selectedMonthStart.getFullYear()}년 ${selectedMonthStart.getMonth() + 1}월`;

  const reservationBounds = await prisma.reservation.aggregate({
    _min: { startTime: true },
    _max: { startTime: true },
  });
  const firstDataMonth = reservationBounds._min.startTime
    ? minDate(new Date(reservationBounds._min.startTime.getFullYear(), reservationBounds._min.startTime.getMonth(), 1), SERVICE_START_MONTH)
    : SERVICE_START_MONTH;
  const lastDataMonth = reservationBounds._max.startTime
    ? maxDate(new Date(reservationBounds._max.startTime.getFullYear(), reservationBounds._max.startTime.getMonth(), 1), currentMonthStart)
    : currentMonthStart;
  const monthOptions = buildMonthOptions(firstDataMonth, lastDataMonth, selectedMonthStart);
  const activeAlerts = await prisma.adminAlert.findMany({
    where: { resolved: false, dismissedAt: null },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  // Fetch today's reservations (오늘 들어온 예약 — 메일 자동연동 + 수동 예약 모두 포함)
  const todayReservations = await prisma.reservation.findMany({
    where: {
      createdAt: {
        gte: startOfToday,
        lte: endOfToday
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      usageLog: true
    }
  });

  // Fetch selected month's reservations
  const thisMonthReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: selectedMonthStart,
        lte: selectedMonthEnd
      }
    },
    orderBy: {
      startTime: "asc"
    },
    include: {
      usageLog: true
    }
  });

  const firstWeekStartOfMonth = startOfWeekMonday(selectedMonthStart);
  const todayWeekStart = startOfWeekMonday(startOfToday);
  const parsedWeekStart = parseDateParam(weekStartParam);
  const defaultWeekStart =
    selectedMonthKey === monthKey(startOfToday) ? todayWeekStart : firstWeekStartOfMonth;
  const parsedWeekEnd = parsedWeekStart ? new Date(parsedWeekStart.getTime() + 6 * DAY_MS) : null;
  const parsedWeekIntersectsSelectedMonth =
    parsedWeekStart && parsedWeekEnd && parsedWeekStart <= selectedMonthEnd && parsedWeekEnd >= selectedMonthStart;

  const weekStartForFilter = parsedWeekIntersectsSelectedMonth
    ? parsedWeekStart
    : defaultWeekStart;

  const rawEndOfSelectedWeek = new Date(weekStartForFilter.getTime() + 6 * DAY_MS);
  rawEndOfSelectedWeek.setHours(23, 59, 59, 999);

  const startOfSelectedWeek = maxDate(weekStartForFilter, selectedMonthStart);
  const endOfSelectedWeek = minDate(rawEndOfSelectedWeek, selectedMonthEnd);
  const startOfSelectedWeekStr = dateKey(weekStartForFilter);

  // Fetch selected week's reservations
  const thisWeekReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: startOfSelectedWeek,
        lte: endOfSelectedWeek
      }
    },
    include: {
      usageLog: true
    }
  });

  const activeMonthly = thisMonthReservations.filter(r => r.status !== "CANCELLED");
  // 이용객(실제 인원)은 실제 이용한 건만 → 취소·노쇼 제외 (노쇼는 아무도 안 왔으니 0명)
  const sumGuests = (list: typeof activeMonthly) => list.reduce((sum, r) => sum + (r.usageLog?.headCount ?? 0), 0);
  const monthlyGuests = sumGuests(activeMonthly);
  const room1Guests = sumGuests(activeMonthly.filter(r => r.roomName === "머무룸1"));
  const room2Guests = sumGuests(activeMonthly.filter(r => r.roomName === "머무룸2"));
  // 건수는 "성사된 예약" 기준 → 노쇼는 포함(슬롯 판매됨), 일반 취소만 제외
  const countedMonthly = thisMonthReservations.filter(r => r.status !== "CANCELLED" || r.isNoShow);
  // 총 예약 시간 (성사된 건 기준, 공간별 분리)
  const sumHours = (list: typeof countedMonthly) =>
    Math.round(list.reduce((s, r) => s + (r.endTime.getTime() - r.startTime.getTime()) / 3600000, 0));
  const monthHours = sumHours(countedMonthly);
  const room1Hours = sumHours(countedMonthly.filter(r => r.roomName === "머무룸1"));
  const room2Hours = sumHours(countedMonthly.filter(r => r.roomName === "머무룸2"));
  // 매출 = 캘린더에 표시되는 최종금액(price) 합계. extraPrice는 추가금 사유/금액 기록용이며 중복 합산하지 않는다.
  const monthlyRevenue = thisMonthReservations.reduce((sum, res) => sum + res.price, 0);
  const sumPrice = (list: typeof thisMonthReservations) => list.reduce((s, r) => s + r.price, 0);
  const room1Revenue = `${sumPrice(thisMonthReservations.filter(r => r.roomName === "머무룸1")).toLocaleString()}원`;
  const room2Revenue = `${sumPrice(thisMonthReservations.filter(r => r.roomName === "머무룸2")).toLocaleString()}원`;

  const revenueText = `${monthlyRevenue.toLocaleString()}원`;

  const room1Count = countedMonthly.filter(r => r.roomName === "머무룸1").length;
  const room2Count = countedMonthly.filter(r => r.roomName === "머무룸2").length;

  const activeWeekly = thisWeekReservations.filter(r => r.status !== "CANCELLED");
  const weeklyGuests = sumGuests(activeWeekly);
  const wRoom1Guests = sumGuests(activeWeekly.filter(r => r.roomName === "머무룸1"));
  const wRoom2Guests = sumGuests(activeWeekly.filter(r => r.roomName === "머무룸2"));
  const countedWeekly = thisWeekReservations.filter(r => r.status !== "CANCELLED" || r.isNoShow);
  const weeklyRevenue = thisWeekReservations.reduce((sum, res) => sum + res.price, 0);
  const wRoom1Revenue = `${sumPrice(thisWeekReservations.filter(r => r.roomName === "머무룸1")).toLocaleString()}원`;
  const wRoom2Revenue = `${sumPrice(thisWeekReservations.filter(r => r.roomName === "머무룸2")).toLocaleString()}원`;

  const wRevenueText = `${weeklyRevenue.toLocaleString()}원`;

  const wRoom1Count = countedWeekly.filter(r => r.roomName === "머무룸1").length;
  const wRoom2Count = countedWeekly.filter(r => r.roomName === "머무룸2").length;
  const weekHours = sumHours(countedWeekly);
  const wRoom1Hours = sumHours(countedWeekly.filter(r => r.roomName === "머무룸1"));
  const wRoom2Hours = sumHours(countedWeekly.filter(r => r.roomName === "머무룸2"));

  // Determine week number for the title
  let weekNum = 1;
  const currentWeekIter = new Date(firstWeekStartOfMonth);
  currentWeekIter.setHours(0, 0, 0, 0);

  while (currentWeekIter <= selectedMonthEnd) {
    if (currentWeekIter.getTime() === weekStartForFilter.getTime()) {
      break;
    }
    currentWeekIter.setDate(currentWeekIter.getDate() + 7);
    weekNum++;
  }

  return (
    <div className="p-4 md:p-8 space-y-6 pb-20 max-w-7xl mx-auto w-full">
      <AutoRefresh />
      <header className="pt-8 pb-4 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            머무룸 대시보드
          </h1>
          <p className="text-sm text-slate-500 mt-1">실시간 예약 및 연동 이용현황을 분석합니다.</p>
        </div>
        <EmailSyncButton />
      </header>

      <DismissibleAdminAlerts
        key={activeAlerts.map((alert) => `${alert.id}:${alert.updatedAt.getTime()}`).join("|")}
        alerts={activeAlerts.map((alert) => ({
          id: alert.id,
          title: alert.title,
          message: alert.message,
        }))}
      />

      {/* Summary Cards (Top) */}
      <section className="space-y-6">
        {/* Monthly Stats */}
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{selectedMonthLabel} 현황</h2>
              <span className="text-xs text-slate-400">선택한 월 예약 통계</span>
            </div>
            <div className="bg-slate-100 rounded-lg px-2 py-1 w-fit">
              <MonthFilter currentMonth={selectedMonthKey} months={monthOptions} />
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-indigo-50 rounded-full text-indigo-600">
                <Clock className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">총 예약 시간</p>
              <p className="text-2xl font-semibold text-slate-900">{monthHours}시간</p>
              <p className="text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Hours} · <span className="text-purple-600">룸2</span> {room2Hours}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-sky-50 rounded-full text-sky-600">
                <Calendar className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">예약 건수</p>
              <p className="text-2xl font-semibold text-slate-900">{countedMonthly.length}건</p>
              <p className="text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Count} · <span className="text-purple-600">룸2</span> {room2Count}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-emerald-50 rounded-full text-emerald-600">
                <Users className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 이용객</p>
              <p className="text-2xl font-semibold text-slate-900">{monthlyGuests}명</p>
              <p className="text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Guests} · <span className="text-purple-600">룸2</span> {room2Guests}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-rose-50 rounded-full text-rose-600">
                <TrendingUp className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 매출</p>
              <p className="text-xl font-semibold tabular-nums text-slate-900 sm:text-2xl">{revenueText}</p>
              <p className="text-center text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Revenue} · <span className="text-purple-600">룸2</span> {room2Revenue}
              </p>
            </div>
          </div>
        </div>

        {/* Weekly Stats */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-900">{selectedMonthStart.getMonth() + 1}월 {weekNum}주차 현황</h2>
            <div className="bg-slate-100 rounded-lg px-2 py-1">
              <WeekFilter currentWeekStart={startOfSelectedWeekStr} monthStart={dateKey(selectedMonthStart)} />
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-indigo-400 shadow-sm">
                <Clock className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">총 예약 시간</p>
              <p className="text-xl font-bold text-slate-800">{weekHours}시간</p>
              <p className="text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Hours} · <span className="text-purple-600">룸2</span> {wRoom2Hours}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-sky-400 shadow-sm">
                <Calendar className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">예약 건수</p>
              <p className="text-xl font-bold text-slate-800">{countedWeekly.length}건</p>
              <p className="text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Count} · <span className="text-purple-600">룸2</span> {wRoom2Count}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-emerald-400 shadow-sm">
                <Users className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 이용객</p>
              <p className="text-xl font-bold text-slate-800">{weeklyGuests}명</p>
              <p className="text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Guests} · <span className="text-purple-600">룸2</span> {wRoom2Guests}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-rose-400 shadow-sm">
                <TrendingUp className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 매출</p>
              <p className="text-xl font-bold text-slate-800">{wRevenueText}</p>
              <p className="text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Revenue} · <span className="text-purple-600">룸2</span> {wRoom2Revenue}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Today's Reservations */}
      <section className="space-y-3 pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">오늘 접수 예약 ({todayReservations.length}건)</h2>
          <span className="text-xs text-slate-400">오늘 접수된 예약</span>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <TodayReservationsList reservations={todayReservations} />
        </div>
      </section>

      {/* This Month's Reservations */}
      <section className="space-y-3 pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">{selectedMonthLabel} 예약 일정</h2>
          <span className="text-xs text-slate-400">다가오는 일정 우선</span>
        </div>
        <MonthlyReservationsList reservations={thisMonthReservations} />
      </section>
    </div>
  );
}
