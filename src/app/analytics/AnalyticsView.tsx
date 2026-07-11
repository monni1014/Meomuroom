"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { CalendarDays, Loader2 } from "lucide-react";
import { UNCATEGORIZED_LABEL } from "@/lib/categories";

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
  reservedHeadCount: number;
}

interface Reservation {
  id: string;
  source: string;
  customerName: string | null;
  startTime: string;
  endTime: string;
  price: number;
  status: string;
  isNoShow: boolean;
  usageLog: UsageLog | null;
}

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6", "#64748b"];
const SERVICE_START_YEAR = 2025;
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);

function getKstDateParts(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const kstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: kstDate.getUTCFullYear(),
    month: kstDate.getUTCMonth() + 1,
    day: kstDate.getUTCDate(),
  };
}

export default function AnalyticsPage() {
  const currentPeriod = getKstDateParts(new Date());
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);
  const [selectedYear, setSelectedYear] = useState(currentPeriod.year);
  const [selectedMonth, setSelectedMonth] = useState(currentPeriod.month);

  useEffect(() => {
    setTimeout(() => {
      setIsMounted(true);
    }, 0);
    const fetchReservations = async () => {
      try {
        const res = await fetch("/api/reservations");
        if (res.ok) {
          const data = await res.json();
          setReservations(data);
        }
      } catch (err) {
        console.error("Error loaded reservations for analytics:", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchReservations();
  }, []);

  const latestDataYear = reservations.reduce((latest, reservation) => {
    return Math.max(latest, getKstDateParts(reservation.startTime).year);
  }, currentPeriod.year);
  const lastYear = Math.max(currentPeriod.year, latestDataYear, SERVICE_START_YEAR);
  const yearOptions = Array.from(
    { length: lastYear - SERVICE_START_YEAR + 1 },
    (_, index) => SERVICE_START_YEAR + index,
  );
  const selectedPeriodLabel = `${selectedYear}년 ${selectedMonth}월`;

  const selectedMonthReservations = reservations.filter((res) => {
    const date = getKstDateParts(res.startTime);
    return date.year === selectedYear && date.month === selectedMonth;
  });

  // 1. Calculate PIE_DATA based on actual purposes (취소 건은 실제 이용이 아니므로 제외)
  const purposeRevenue: Record<string, number> = {};
  let totalPurposeRevenue = 0;
  selectedMonthReservations
    .filter((res) => res.status !== "CANCELLED")
    .forEach((res) => {
      const purpose = res.usageLog?.purpose || UNCATEGORIZED_LABEL;
      const price = (res.price || 0);
      purposeRevenue[purpose] = (purposeRevenue[purpose] || 0) + price;
      totalPurposeRevenue += price;
    });

  const hasPurposeData = Object.keys(purposeRevenue).length > 0;
  const pieData = hasPurposeData
    ? Object.entries(purposeRevenue)
        .sort((a, b) => b[1] - a[1]) // 매출 높은 순 정렬
        .map(([name, value]) => ({ 
          name, 
          value, 
          percentage: totalPurposeRevenue > 0 ? Math.round((value / totalPurposeRevenue) * 100) : 0 
        }))
    : [];

  // 2. Calculate BAR_DATA (Weekly sales for current booking months)
  const weekRevenue = [0, 0, 0, 0]; // 1, 2, 3, 4th weeks
  selectedMonthReservations.forEach((res) => {
    const day = getKstDateParts(res.startTime).day;
    const price = (res.price || 0);
    if (day <= 7) weekRevenue[0] += price;
    else if (day <= 14) weekRevenue[1] += price;
    else if (day <= 21) weekRevenue[2] += price;
    else weekRevenue[3] += price;
  });

  const barData = [
    { name: "1주차", 매출: weekRevenue[0] },
    { name: "2주차", 매출: weekRevenue[1] },
    { name: "3주차", 매출: weekRevenue[2] },
    { name: "4주차", 매출: weekRevenue[3] },
  ];

  // 3. Dynamic scenario percentages based on accumulated sales
  const totalRevenue = selectedMonthReservations.reduce((sum, res) => sum + (res.price || 0), 0);

  // 취소/노쇼 집계 (대시보드엔 안 띄우고 통계에서만 표기)
  const cancelledList = selectedMonthReservations.filter((res) => res.status === "CANCELLED");
  const noShowList = cancelledList.filter((res) => res.isNoShow);
  const realCancelList = cancelledList.filter((res) => !res.isNoShow);
  const noShowCount = noShowList.length;
  const realCancelCount = realCancelList.length;
  const cancelledFee = cancelledList.reduce((sum, res) => sum + (res.price || 0), 0); // 취소+노쇼 수수료 합
  // 예약 건수 = 성사된 건(확정 + 노쇼). 일반 취소만 제외.
  const bookedCount = selectedMonthReservations.length - realCancelCount;

  // 경쟁사 매출 추정을 위한 핵심 지표 계산
  let totalPersonHours = 0;
  let totalHours = 0;
  let validRevenueForAvg = 0;

  selectedMonthReservations
    .filter((res) => res.status !== "CANCELLED")
    .forEach((res) => {
      const start = new Date(res.startTime).getTime();
      const end = new Date(res.endTime).getTime();
      const hours = Math.max(0, (end - start) / (1000 * 60 * 60)); // 이용 시간 (시간 단위)

      let minHeadcount = 4; // 기본
      if (res.source === "naver") minHeadcount = 4;
      else if (res.source === "spacecloud") minHeadcount = 5;

      const observedHeadCount = res.usageLog?.headCount || 0;
      const reservedHeadCount = res.usageLog?.reservedHeadCount || 0;
      const actualHeadcount = Math.max(observedHeadCount, reservedHeadCount);
      const billedHeadcount = Math.max(actualHeadcount, minHeadcount); // 최소 보증 인원 적용

      const personHours = hours * billedHeadcount;
      totalPersonHours += personHours;
      totalHours += hours;
      validRevenueForAvg += (res.price || 0);
    });

  const timeWeightedAvgHeadcount = totalHours > 0 ? (totalPersonHours / totalHours) : 0;
  const avgPricePerPersonPerHour = totalPersonHours > 0 ? (validRevenueForAvg / totalPersonHours) : 0;

  // Targets: Scenario 1 (Conservative: 15만 원), Scenario 2 (Standard: 35만 원), Scenario 3 (Aggressive: 60만 원)
  const t1 = 150000;
  const t2 = 350000;
  const t3 = 600000;

  const rate1 = Math.round((totalRevenue / t1) * 100);
  const rate2 = Math.round((totalRevenue / t2) * 100);
  const rate3 = Math.round((totalRevenue / t3) * 100);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-slate-500 gap-2">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <span className="text-sm font-semibold">통계 데이터 분석 중...</span>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 pb-24 max-w-5xl mx-auto w-full">
      <header className="flex flex-col gap-4 pt-8 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">결산 및 통계</h1>
          <p className="text-sm text-slate-500 mt-1">포스 및 예약 채널 실시간 자동 종합 레포트</p>
        </div>
        <div className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm md:w-auto">
          <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <label className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-none">
            <span className="text-xs font-semibold text-slate-500">연도</span>
            <select
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value))}
              className="min-w-20 cursor-pointer bg-transparent text-sm font-semibold text-slate-800 outline-none"
              aria-label="통계 연도 선택"
            >
              {yearOptions.map((year) => (
                <option key={year} value={year}>{year}년</option>
              ))}
            </select>
          </label>
          <div className="h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <label className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-none">
            <span className="text-xs font-semibold text-slate-500">월</span>
            <select
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(Number(event.target.value))}
              className="min-w-16 cursor-pointer bg-transparent text-sm font-semibold text-slate-800 outline-none"
              aria-label="통계 월 선택"
            >
              {MONTH_OPTIONS.map((month) => (
                <option key={month} value={month}>{month}월</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* Revenue Summary Banner */}
      <div className="p-5 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 text-white rounded-2xl shadow-lg shadow-indigo-200/50 space-y-1 relative overflow-hidden">
        {/* 장식용 빛 반사 효과 */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
        <p className="text-[11px] font-bold tracking-wider text-white/80 uppercase relative z-10">{selectedPeriodLabel} 총 매출액</p>
        <p className="text-3xl font-extrabold relative z-10">{totalRevenue.toLocaleString()}원</p>
        <p className="text-[10px] text-white/70 mt-2 font-medium relative z-10">네이버 및 스페이스클라우드 webhook 실시간 종합 집계액</p>
      </div>

      {/* 경쟁사 분석용 핵심 지표 (시간 가중 평균 통계) */}
      <section className="bg-gradient-to-br from-slate-50 to-white p-5 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
          <span className="bg-indigo-100 text-indigo-700 p-1.5 rounded-lg"><CalendarDays className="w-4 h-4" /></span>
          경쟁사 매출 추정용 지표 (시간 가중 평균)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-2 h-full bg-blue-400"></div>
            <p className="text-[11px] font-bold text-slate-500 mb-1">시간당 평균 인원</p>
            <p className="text-2xl font-extrabold text-slate-800">{timeWeightedAvgHeadcount.toFixed(1)}<span className="text-sm font-medium text-slate-500 ml-1">명 / 시간</span></p>
            <p className="text-[10px] text-slate-400 mt-2 tracking-tight">최소인원(네이버 4, 스클 5) 보정</p>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-2 h-full bg-indigo-400"></div>
            <p className="text-[11px] font-bold text-slate-500 mb-1">1인당 1시간 평균 단가</p>
            <p className="text-2xl font-extrabold text-slate-800">{Math.round(avgPricePerPersonPerHour).toLocaleString()}<span className="text-sm font-medium text-slate-500 ml-1">원</span></p>
            <p className="text-[10px] text-slate-400 mt-2 tracking-tight">총 매출 ÷ (이용시간 × 결제인원)</p>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-2 h-full bg-violet-400"></div>
            <p className="text-[11px] font-bold text-slate-500 mb-1">우리가 점유한 총 이용 시간</p>
            <p className="text-2xl font-extrabold text-slate-800">{totalHours.toFixed(1)}<span className="text-sm font-medium text-slate-500 ml-1">시간</span></p>
            <p className="text-[10px] text-slate-400 mt-2 tracking-tight">이번 달 누적 공간 대여 시간</p>
          </div>
        </div>
      </section>

      {/* 이용/취소/노쇼 집계 (대시보드엔 없고 통계에서만) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 text-center">
          <p className="text-[11px] font-bold text-slate-400">예약 건수 (노쇼 포함)</p>
          <p className="text-xl font-extrabold text-slate-800 mt-1">{bookedCount}건</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 text-center">
          <p className="text-[11px] font-bold text-slate-400">취소</p>
          <p className="text-xl font-extrabold text-slate-800 mt-1">{realCancelCount}건</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-orange-100 text-center">
          <p className="text-[11px] font-bold text-orange-400">노쇼</p>
          <p className="text-xl font-extrabold text-orange-600 mt-1">{noShowCount}건</p>
        </div>
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 text-center">
          <p className="text-[11px] font-bold text-slate-400">취소·노쇼 수수료</p>
          <p className="text-xl font-extrabold text-slate-800 mt-1">{cancelledFee.toLocaleString()}원</p>
        </div>
      </div>

      {/* Purpose Ratio Section */}
      <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-1.5">
          <span>{selectedPeriodLabel} 이용 목적별 비중 (매출 기준)</span>
        </h2>
        <div className="h-48 w-full flex items-center justify-center">
          {isMounted && hasPurposeData ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={75}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value) => `${Number(value).toLocaleString()}원`} 
                  contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)" }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : !isMounted ? (
            <span className="text-xs text-slate-400 font-semibold animate-pulse">차트를 로딩하는 중...</span>
          ) : (
            <span className="text-sm font-semibold text-slate-400">해당 월 이용 목적 데이터가 없습니다.</span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-y-3 gap-x-4 justify-center mt-3 pt-4 border-t border-slate-50">
          {pieData.map((entry, index) => (
            <div key={entry.name} className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
              <span className="truncate">{entry.name}</span>
              <span className="text-slate-500 font-medium whitespace-nowrap">
                {entry.value.toLocaleString()}원 <span className="text-slate-400 font-normal">({entry.percentage}%)</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Weekly Revenue Section */}
      <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-sm font-bold text-slate-900 mb-4">주차별 매출 추이</h2>
        <div className="h-48 w-full flex items-center justify-center">
          {isMounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData}>
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#64748b", fontWeight: "600" }} />
                <YAxis hide />
                <Tooltip
                  cursor={{ fill: "#f8fafc" }}
                  contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)" }}
                  formatter={(value) => [`${Number(value).toLocaleString()}원`, "매출"]}
                />
                <Bar dataKey="매출" fill="#6366f1" radius={[6, 6, 0, 0]} barSize={28} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <span className="text-xs text-slate-400 font-semibold animate-pulse">차트를 로딩하는 중...</span>
          )}
        </div>
      </section>

      {/* Target Revenue Section */}
      <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 space-y-4">
        <div className="flex justify-between items-center pb-2 border-b border-slate-50">
          <h2 className="text-sm font-bold text-slate-900">목표 매출 달성 현황</h2>
          <span className="text-xs text-slate-400 font-semibold">목표 {t2.toLocaleString()}원 기준</span>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs mb-1.5 font-semibold">
              <span className="text-slate-600">보수적 시나리오 (목표 {t1.toLocaleString()})</span>
              <span className={rate1 >= 100 ? "text-emerald-600 font-bold" : "text-indigo-600"}>{rate1}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, rate1)}%` }}
              ></div>
            </div>
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1.5 font-semibold">
              <span className="text-slate-600">완만 시나리오 (목표 {t2.toLocaleString()})</span>
              <span className="text-indigo-600">{rate2}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, rate2)}%` }}
              ></div>
            </div>
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1.5 font-semibold">
              <span className="text-slate-600">도전적 시나리오 (목표 {t3.toLocaleString()})</span>
              <span className="text-slate-500">{rate3}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div
                className="bg-amber-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, rate3)}%` }}
              ></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
