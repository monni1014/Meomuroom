import { Calendar, Users, TrendingUp, Clock } from "lucide-react";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import EmailSyncButton from "./EmailSyncButton";
import AutoRefresh from "./AutoRefresh";
import MonthlyReservationsList from "@/components/MonthlyReservationsList";
import TodayReservationsList from "@/components/TodayReservationsList";
import WeekFilter from "@/components/WeekFilter";
import MonthFilter from "@/components/MonthFilter";
import DismissibleAdminAlerts from "@/components/DismissibleAdminAlerts";
import { addKstMonths, createKstDate, getKstDateParts, getKstDayRange, startOfKstMonth } from "@/lib/kst-time";

export const dynamic = "force-dynamic";

const SERVICE_START_MONTH = createKstDate(2025, 8, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function formatTenThousandWon(value: number, suffix = "만원") {
  const amount = Math.round(value / 1_000) / 10;
  return `${amount.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${suffix}`;
}

function monthKey(date: Date) {
  const parts = getKstDateParts(date);
  return `${parts.year}-${pad2(parts.month)}`;
}

function dateKey(date: Date) {
  const parts = getKstDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseMonthParam(value: string | undefined, fallback: Date) {
  const match = value?.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return startOfKstMonth(fallback);
  return createKstDate(Number(match[1]), Number(match[2]), 1);
}

function parseDateParam(value: string | undefined) {
  const match = value?.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = createKstDate(year, month, day);
  const parts = getKstDateParts(date);
  return parts.year === year && parts.month === month && parts.day === day ? date : null;
}

function startOfWeekMonday(date: Date) {
  const parts = getKstDateParts(date);
  const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return new Date(createKstDate(parts.year, parts.month, parts.day).getTime() + offset * DAY_MS);
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
  let current = startOfKstMonth(rangeStart);
  const last = startOfKstMonth(rangeEnd);
  const options: { value: string; label: string }[] = [];

  while (current <= last) {
    const parts = getKstDateParts(current);
    options.push({
      value: monthKey(current),
      label: `${parts.year}년 ${parts.month}월`,
    });
    current = addKstMonths(current, 1);
  }

  return options;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function DashboardPage(props: { searchParams?: Promise<any> | any }) {
  const searchParams = await Promise.resolve(props.searchParams || {});
  const weekStartParam = searchParams.weekStart as string | undefined;
  const monthParam = searchParams.month as string | undefined;

  // Always use explicit Korea Standard Time boundaries, independent of server timezone.
  const now = new Date();
  const { start: startOfToday, end: endOfToday } = getKstDayRange(now);

  const currentMonthStart = startOfKstMonth(now);
  const selectedMonthStart = parseMonthParam(monthParam, currentMonthStart);
  const selectedMonthEnd = new Date(addKstMonths(selectedMonthStart, 1).getTime() - 1);
  const selectedMonthKey = monthKey(selectedMonthStart);
  const selectedMonthParts = getKstDateParts(selectedMonthStart);
  const selectedMonthLabel = `${selectedMonthParts.year}년 ${selectedMonthParts.month}월`;

  const reservationBounds = await prisma.reservation.aggregate({
    _min: { startTime: true },
    _max: { startTime: true },
  });
  const firstDataMonth = reservationBounds._min.startTime
    ? minDate(startOfKstMonth(reservationBounds._min.startTime), SERVICE_START_MONTH)
    : SERVICE_START_MONTH;
  const lastDataMonth = reservationBounds._max.startTime
    ? maxDate(startOfKstMonth(reservationBounds._max.startTime), currentMonthStart)
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

  const rawEndOfSelectedWeek = new Date(weekStartForFilter.getTime() + 7 * DAY_MS - 1);

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
  const room3Guests = sumGuests(activeMonthly.filter(r => r.roomName === "머무룸3"));
  // 건수는 "성사된 예약" 기준 → 노쇼는 포함(슬롯 판매됨), 일반 취소만 제외
  const countedMonthly = thisMonthReservations.filter(r => r.status !== "CANCELLED" || r.isNoShow);
  // 총 예약 시간 (성사된 건 기준, 공간별 분리)
  const sumHours = (list: typeof countedMonthly) =>
    Math.round(list.reduce((s, r) => s + (r.endTime.getTime() - r.startTime.getTime()) / 3600000, 0));
  const monthHours = sumHours(countedMonthly);
  const room1Hours = sumHours(countedMonthly.filter(r => r.roomName === "머무룸1"));
  const room2Hours = sumHours(countedMonthly.filter(r => r.roomName === "머무룸2"));
  const room3Hours = sumHours(countedMonthly.filter(r => r.roomName === "머무룸3"));
  // 매출 = 캘린더에 표시되는 최종금액(price) 합계. extraPrice는 추가금 사유/금액 기록용이며 중복 합산하지 않는다.
  const monthlyRevenue = thisMonthReservations.reduce((sum, res) => sum + res.price, 0);
  const sumPrice = (list: typeof thisMonthReservations) => list.reduce((s, r) => s + r.price, 0);
  const room1Revenue = sumPrice(thisMonthReservations.filter(r => r.roomName === "머무룸1"));
  const room2Revenue = sumPrice(thisMonthReservations.filter(r => r.roomName === "머무룸2"));
  const room3Revenue = sumPrice(thisMonthReservations.filter(r => r.roomName === "머무룸3"));

  const revenueText = `${monthlyRevenue.toLocaleString()}원`;
  const mobileRevenueText = formatTenThousandWon(monthlyRevenue);

  const room1Count = countedMonthly.filter(r => r.roomName === "머무룸1").length;
  const room2Count = countedMonthly.filter(r => r.roomName === "머무룸2").length;
  const room3Count = countedMonthly.filter(r => r.roomName === "머무룸3").length;

  const activeWeekly = thisWeekReservations.filter(r => r.status !== "CANCELLED");
  const weeklyGuests = sumGuests(activeWeekly);
  const wRoom1Guests = sumGuests(activeWeekly.filter(r => r.roomName === "머무룸1"));
  const wRoom2Guests = sumGuests(activeWeekly.filter(r => r.roomName === "머무룸2"));
  const wRoom3Guests = sumGuests(activeWeekly.filter(r => r.roomName === "머무룸3"));
  const countedWeekly = thisWeekReservations.filter(r => r.status !== "CANCELLED" || r.isNoShow);
  const weeklyRevenue = thisWeekReservations.reduce((sum, res) => sum + res.price, 0);
  const wRoom1Revenue = sumPrice(thisWeekReservations.filter(r => r.roomName === "머무룸1"));
  const wRoom2Revenue = sumPrice(thisWeekReservations.filter(r => r.roomName === "머무룸2"));
  const wRoom3Revenue = sumPrice(thisWeekReservations.filter(r => r.roomName === "머무룸3"));

  const wRevenueText = `${weeklyRevenue.toLocaleString()}원`;
  const mobileWeeklyRevenueText = formatTenThousandWon(weeklyRevenue);

  const wRoom1Count = countedWeekly.filter(r => r.roomName === "머무룸1").length;
  const wRoom2Count = countedWeekly.filter(r => r.roomName === "머무룸2").length;
  const wRoom3Count = countedWeekly.filter(r => r.roomName === "머무룸3").length;
  const weekHours = sumHours(countedWeekly);
  const wRoom1Hours = sumHours(countedWeekly.filter(r => r.roomName === "머무룸1"));
  const wRoom2Hours = sumHours(countedWeekly.filter(r => r.roomName === "머무룸2"));
  const wRoom3Hours = sumHours(countedWeekly.filter(r => r.roomName === "머무룸3"));

  // Determine week number for the title
  let weekNum = 1;
  const currentWeekIter = new Date(firstWeekStartOfMonth);

  while (currentWeekIter <= selectedMonthEnd) {
    if (currentWeekIter.getTime() === weekStartForFilter.getTime()) {
      break;
    }
    currentWeekIter.setTime(currentWeekIter.getTime() + 7 * DAY_MS);
    weekNum++;
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 pb-20 md:p-8">
      <AutoRefresh />
      <header className="flex items-start justify-between gap-3 pb-4 pt-8 sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Image
              src="/icon-192.png"
              alt="머무룸 로고"
              width={28}
              height={28}
              className="h-7 w-7"
              priority
            />
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              머무룸 대시보드
            </h1>
          </div>
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
      <section className="order-2 space-y-6 md:order-1">
        {/* Monthly Stats */}
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{selectedMonthLabel} 현황</h2>
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
              <p className="text-center text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Hours} · <span className="text-purple-600">룸2</span> {room2Hours} · <span className="text-orange-600">룸3</span> {room3Hours}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-sky-50 rounded-full text-sky-600">
                <Calendar className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">예약 건수</p>
              <p className="text-2xl font-semibold text-slate-900">{countedMonthly.length}건</p>
              <p className="text-center text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Count} · <span className="text-purple-600">룸2</span> {room2Count} · <span className="text-orange-600">룸3</span> {room3Count}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-emerald-50 rounded-full text-emerald-600">
                <Users className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 이용객</p>
              <p className="text-2xl font-semibold text-slate-900">{monthlyGuests}명</p>
              <p className="text-center text-xs text-slate-400">
                <span className="text-sky-600">룸1</span> {room1Guests} · <span className="text-purple-600">룸2</span> {room2Guests} · <span className="text-orange-600">룸3</span> {room3Guests}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-rose-50 rounded-full text-rose-600">
                <TrendingUp className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 매출</p>
              <p className="text-xl font-semibold tabular-nums text-slate-900 sm:text-2xl">
                <span className="sm:hidden">{mobileRevenueText}</span>
                <span className="hidden sm:inline">{revenueText}</span>
              </p>
              <div className="grid w-full grid-cols-3 gap-1 text-center text-[9px] tabular-nums text-slate-400 sm:hidden">
                <span><span className="text-sky-600">룸1</span><br />{formatTenThousandWon(room1Revenue, "만")}</span>
                <span><span className="text-purple-600">룸2</span><br />{formatTenThousandWon(room2Revenue, "만")}</span>
                <span><span className="text-orange-600">룸3</span><br />{formatTenThousandWon(room3Revenue, "만")}</span>
              </div>
              <p className="hidden whitespace-nowrap text-center text-xs tabular-nums text-slate-400 sm:block">
                <span className="text-sky-600">룸1</span> {room1Revenue.toLocaleString()} · <span className="text-purple-600">룸2</span> {room2Revenue.toLocaleString()} · <span className="text-orange-600">룸3</span> {room3Revenue.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Weekly Stats */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-900">{selectedMonthParts.month}월 {weekNum}주차 현황</h2>
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
              <p className="text-center text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Hours} · <span className="text-purple-600">룸2</span> {wRoom2Hours} · <span className="text-orange-600">룸3</span> {wRoom3Hours}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-sky-400 shadow-sm">
                <Calendar className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">예약 건수</p>
              <p className="text-xl font-bold text-slate-800">{countedWeekly.length}건</p>
              <p className="text-center text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Count} · <span className="text-purple-600">룸2</span> {wRoom2Count} · <span className="text-orange-600">룸3</span> {wRoom3Count}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-emerald-400 shadow-sm">
                <Users className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 이용객</p>
              <p className="text-xl font-bold text-slate-800">{weeklyGuests}명</p>
              <p className="text-center text-[11px] text-slate-400">
                <span className="text-sky-600">룸1</span> {wRoom1Guests} · <span className="text-purple-600">룸2</span> {wRoom2Guests} · <span className="text-orange-600">룸3</span> {wRoom3Guests}
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-1.5">
              <div className="p-3 bg-white rounded-full text-rose-400 shadow-sm">
                <TrendingUp className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 매출</p>
              <p className="text-xl font-bold tabular-nums text-slate-800">
                <span className="sm:hidden">{mobileWeeklyRevenueText}</span>
                <span className="hidden sm:inline">{wRevenueText}</span>
              </p>
              <div className="grid w-full grid-cols-3 gap-1 text-center text-[9px] tabular-nums text-slate-400 sm:hidden">
                <span><span className="text-sky-600">룸1</span><br />{formatTenThousandWon(wRoom1Revenue, "만")}</span>
                <span><span className="text-purple-600">룸2</span><br />{formatTenThousandWon(wRoom2Revenue, "만")}</span>
                <span><span className="text-orange-600">룸3</span><br />{formatTenThousandWon(wRoom3Revenue, "만")}</span>
              </div>
              <p className="hidden whitespace-nowrap text-center text-[11px] tabular-nums text-slate-400 sm:block">
                <span className="text-sky-600">룸1</span> {wRoom1Revenue.toLocaleString()} · <span className="text-purple-600">룸2</span> {wRoom2Revenue.toLocaleString()} · <span className="text-orange-600">룸3</span> {wRoom3Revenue.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Today's Reservations */}
      <section className="order-1 space-y-3 md:order-2 md:pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">오늘 접수 예약 ({todayReservations.length}건)</h2>
          <span className="text-xs text-slate-400">오늘 접수된 예약</span>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <TodayReservationsList reservations={todayReservations} />
        </div>
      </section>

      {/* This Month's Reservations */}
      <section className="order-3 space-y-3 pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">{selectedMonthLabel} 예약 일정</h2>
          <span className="text-xs text-slate-400">다가오는 일정 우선</span>
        </div>
        <MonthlyReservationsList reservations={thisMonthReservations} />
      </section>
    </div>
  );
}
