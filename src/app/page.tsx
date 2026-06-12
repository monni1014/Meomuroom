import { Calendar, Users, Coffee, TrendingUp, RefreshCw, Building2 } from "lucide-react";
import { prisma } from "@/lib/prisma";
import EmailSyncButton from "./EmailSyncButton";
import AutoRefresh from "./AutoRefresh";
import { UNCATEGORIZED_LABEL } from "@/lib/categories";
import MonthlyReservationsList from "@/components/MonthlyReservationsList";
import TodayReservationsList from "@/components/TodayReservationsList";
import WeekFilter from "@/components/WeekFilter";

export const dynamic = "force-dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function DashboardPage(props: { searchParams?: Promise<any> | any }) {
  const searchParams = await Promise.resolve(props.searchParams || {});
  const weekStartParam = searchParams.weekStart as string | undefined;

  // Get current date boundaries for Today
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  // Get current date boundaries for This Month
  const startOfThisMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
  const endOfThisMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth() + 1, 0, 23, 59, 59, 999);

  // Fetch today's reservations (오늘 메일로 연동되어 들어온 예약만 표시)
  const todayReservations = await prisma.reservation.findMany({
    where: {
      createdAt: {
        gte: startOfToday,
        lte: endOfToday
      },
      emailId: {
        not: null
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      usageLog: true
    }
  });

  // Fetch this month's reservations
  const thisMonthReservations = await prisma.reservation.findMany({
    where: {
      startTime: {
        gte: startOfThisMonth,
        lte: endOfThisMonth
      }
    },
    orderBy: {
      startTime: "asc"
    },
    include: {
      usageLog: true
    }
  });

  // Get current date boundaries for Selected Week (Monday to Sunday)
  let startOfSelectedWeek: Date;
  
  if (weekStartParam) {
    startOfSelectedWeek = new Date(weekStartParam);
    startOfSelectedWeek.setHours(0, 0, 0, 0);
  } else {
    // Default to the current week's Monday
    const monday = new Date(startOfToday);
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
    monday.setDate(diff);
    
    startOfSelectedWeek = new Date(monday);
    startOfSelectedWeek.setHours(0, 0, 0, 0);
  }

  // Clamp to current month boundaries so week stats don't bleed into other months
  if (startOfSelectedWeek < startOfThisMonth) {
    startOfSelectedWeek = new Date(startOfThisMonth);
  }
  
  let endOfSelectedWeek = new Date(startOfSelectedWeek);
  // Original end of week was startOfSelectedWeek + 6 days, but since start might be clamped, 
  // we calculate from the actual week start.
  if (weekStartParam) {
    const wStart = new Date(weekStartParam);
    endOfSelectedWeek = new Date(wStart);
    endOfSelectedWeek.setDate(wStart.getDate() + 6);
  } else {
    // If no param, we find the Monday of today's week
    const monday = new Date(startOfToday);
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
    monday.setDate(diff);
    endOfSelectedWeek = new Date(monday);
    endOfSelectedWeek.setDate(monday.getDate() + 6);
  }
  endOfSelectedWeek.setHours(23, 59, 59, 999);

  if (endOfSelectedWeek > endOfThisMonth) {
    endOfSelectedWeek = new Date(endOfThisMonth);
  }

  // Pad function for formatting YYYY-MM-DD
  const pad = (n: number) => n.toString().padStart(2, "0");
  
  // We need to pass the actual Monday to WeekFilter so it matches the option values
  let weekStartForFilter = new Date(startOfToday);
  if (weekStartParam) {
    weekStartForFilter = new Date(weekStartParam);
  } else {
    const day = weekStartForFilter.getDay();
    const diff = weekStartForFilter.getDate() - day + (day === 0 ? -6 : 1);
    weekStartForFilter.setDate(diff);
  }
  const startOfSelectedWeekStr = `${weekStartForFilter.getFullYear()}-${pad(weekStartForFilter.getMonth() + 1)}-${pad(weekStartForFilter.getDate())}`;

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
  const monthlyGuests = activeMonthly.reduce((sum, r) => sum + (r.usageLog?.headCount ?? 0), 0);
  const monthlyRevenue = thisMonthReservations.reduce((sum, res) => sum + res.price + (res.usageLog?.extraPrice || 0), 0);
  
  const revenueText = monthlyRevenue >= 10000 
    ? (monthlyRevenue / 10000).toFixed(1) + "만" 
    : monthlyRevenue.toLocaleString();

  const room1Count = thisMonthReservations.filter(r => r.roomName === "머무룸1").length;
  const room2Count = thisMonthReservations.filter(r => r.roomName === "머무룸2").length;

  const activeWeekly = thisWeekReservations.filter(r => r.status !== "CANCELLED");
  const weeklyGuests = activeWeekly.reduce((sum, r) => sum + (r.usageLog?.headCount ?? 0), 0);
  const weeklyRevenue = thisWeekReservations.reduce((sum, res) => sum + res.price + (res.usageLog?.extraPrice || 0), 0);
  
  const wRevenueText = weeklyRevenue >= 10000 
    ? (weeklyRevenue / 10000).toFixed(1) + "만" 
    : weeklyRevenue.toLocaleString();

  const wRoom1Count = thisWeekReservations.filter(r => r.roomName === "머무룸1").length;
  const wRoom2Count = thisWeekReservations.filter(r => r.roomName === "머무룸2").length;

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

  // Determine week number for the title
  let weekNum = 1;
  let currentWeekIter = new Date(startOfThisMonth);
  const iterDay = currentWeekIter.getDay();
  const iterDiff = currentWeekIter.getDate() - iterDay + (iterDay === 0 ? -6 : 1);
  currentWeekIter.setDate(iterDiff);
  currentWeekIter.setHours(0, 0, 0, 0);

  while (currentWeekIter <= endOfThisMonth) {
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

      {/* Summary Cards (Top) */}
      <section className="space-y-6">
        {/* Monthly Stats */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-900">{startOfThisMonth.getMonth() + 1}월 현황</h2>
            <span className="text-xs text-slate-400">이번 달 예약 통계</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-indigo-50 rounded-full text-indigo-600">
                <Calendar className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">이번 달 예약</p>
              <p className="text-2xl font-semibold text-slate-900">{thisMonthReservations.length}건</p>
            </div>
            
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-emerald-50 rounded-full text-emerald-600">
                <Users className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 이용객</p>
              <p className="text-2xl font-semibold text-slate-900">{monthlyGuests}명</p>
            </div>
            
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-sky-50 rounded-full text-sky-600">
                <Building2 className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">공간별 예약</p>
              <p className="text-lg font-semibold text-slate-900">
                <span className="text-sky-600">룸1</span> {room1Count} · <span className="text-purple-600">룸2</span> {room2Count}
              </p>
            </div>
            
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-rose-50 rounded-full text-rose-600">
                <TrendingUp className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-500">월 매출</p>
              <p className="text-2xl font-semibold text-slate-900">{revenueText}</p>
            </div>
          </div>
        </div>

        {/* Weekly Stats */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-900">{startOfThisMonth.getMonth() + 1}월 {weekNum}주차 현황</h2>
            <div className="bg-slate-100 rounded-lg px-2 py-1">
              <WeekFilter currentWeekStart={startOfSelectedWeekStr} />
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-white rounded-full text-indigo-400 shadow-sm">
                <Calendar className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주간 예약</p>
              <p className="text-xl font-bold text-slate-800">{thisWeekReservations.length}건</p>
            </div>
            
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-white rounded-full text-emerald-400 shadow-sm">
                <Users className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 이용객</p>
              <p className="text-xl font-bold text-slate-800">{weeklyGuests}명</p>
            </div>
            
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-white rounded-full text-sky-400 shadow-sm">
                <Building2 className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">공간별 예약</p>
              <p className="text-base font-bold text-slate-800">
                <span className="text-sky-600">룸1</span> {wRoom1Count} · <span className="text-purple-600">룸2</span> {wRoom2Count}
              </p>
            </div>
            
            <div className="bg-slate-50 p-4 rounded-2xl shadow-inner border border-slate-100 flex flex-col items-center justify-center space-y-2">
              <div className="p-3 bg-white rounded-full text-rose-400 shadow-sm">
                <TrendingUp className="w-5 h-5" />
              </div>
              <p className="text-xs font-medium text-slate-500">주 매출</p>
              <p className="text-xl font-bold text-slate-800">{wRevenueText}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Today's Reservations */}
      <section className="space-y-3 pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">오늘 확정 예약 ({todayReservations.length}건)</h2>
          <span className="text-xs text-slate-400">오늘 접수된 예약</span>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <TodayReservationsList reservations={todayReservations} />
        </div>
      </section>

      {/* This Month's Reservations */}
      <section className="space-y-3 pt-6">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">이 달 예약 일정</h2>
          <span className="text-xs text-slate-400">다가오는 일정 우선</span>
        </div>
        <MonthlyReservationsList reservations={thisMonthReservations} />
      </section>
    </div>
  );
}
