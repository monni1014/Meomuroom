"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { Loader2 } from "lucide-react";
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
}

interface Reservation {
  id: string;
  source: string;
  customerName: string | null;
  startTime: string;
  endTime: string;
  price: number;
  status: string;
  usageLog: UsageLog | null;
}

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6", "#64748b"];

export default function AnalyticsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);

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

  const now = new Date();
  const thisMonthReservations = reservations.filter(res => {
    const d = new Date(res.startTime);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });

  // 1. Calculate PIE_DATA based on actual purposes (취소 건은 실제 이용이 아니므로 제외)
  const purposeRevenue: Record<string, number> = {};
  let totalPurposeRevenue = 0;
  thisMonthReservations
    .filter((res) => res.status !== "CANCELLED")
    .forEach((res) => {
      const purpose = res.usageLog?.purpose || UNCATEGORIZED_LABEL;
      const price = (res.price || 0) + (res.usageLog?.extraPrice || 0);
      purposeRevenue[purpose] = (purposeRevenue[purpose] || 0) + price;
      totalPurposeRevenue += price;
    });

  const pieData = Object.keys(purposeRevenue).length > 0
    ? Object.entries(purposeRevenue)
        .sort((a, b) => b[1] - a[1]) // 매출 높은 순 정렬
        .map(([name, value]) => ({ 
          name, 
          value, 
          percentage: totalPurposeRevenue > 0 ? Math.round((value / totalPurposeRevenue) * 100) : 0 
        }))
    : [
        { name: "데이터 없음", value: 1, percentage: 100 }
      ];

  // 2. Calculate BAR_DATA (Weekly sales for current booking months)
  const weekRevenue = [0, 0, 0, 0]; // 1, 2, 3, 4th weeks
  thisMonthReservations.forEach((res) => {
    const date = new Date(res.startTime);
    const day = date.getDate();
    const price = (res.price || 0) + (res.usageLog?.extraPrice || 0);
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
  const totalRevenue = thisMonthReservations.reduce((sum, res) => sum + (res.price || 0) + (res.usageLog?.extraPrice || 0), 0);

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
      <header className="pt-8 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">결산 및 통계</h1>
        <p className="text-sm text-slate-500 mt-1">포스 및 예약 채널 실시간 자동 종합 레포트</p>
      </header>

      {/* Revenue Summary Banner */}
      <div className="p-5 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 text-white rounded-2xl shadow-lg shadow-indigo-200/50 space-y-1 relative overflow-hidden">
        {/* 장식용 빛 반사 효과 */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
        <p className="text-[11px] font-bold tracking-wider text-white/80 uppercase relative z-10">이달의 총 매출액</p>
        <p className="text-3xl font-extrabold relative z-10">{totalRevenue.toLocaleString()}원</p>
        <p className="text-[10px] text-white/70 mt-2 font-medium relative z-10">네이버 및 스페이스클라우드 webhook 실시간 종합 집계액</p>
      </div>

      {/* Purpose Ratio Section */}
      <section className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-1.5">
          <span>이번 달 이용 목적별 비중 (매출 기준)</span>
        </h2>
        <div className="h-48 w-full flex items-center justify-center">
          {isMounted ? (
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
          ) : (
            <span className="text-xs text-slate-400 font-semibold animate-pulse">차트를 로딩하는 중...</span>
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
