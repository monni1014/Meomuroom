import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, getDay, isBefore, startOfDay } from "date-fns";
import { cn } from "@/lib/utils";

interface MultiDatePickerProps {
  selectedDates: string[];
  onChange: (dates: string[]) => void;
}

export default function MultiDatePicker({ selectedDates, onChange }: MultiDatePickerProps) {
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));

  const nextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));
  const prevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));

  const firstDay = startOfMonth(currentMonth);
  const lastDay = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: firstDay, end: lastDay });
  
  // 패딩용 빈 칸 계산
  const startPadding = getDay(firstDay);

  const toggleDate = (dateStr: string) => {
    if (selectedDates.includes(dateStr)) {
      onChange(selectedDates.filter(d => d !== dateStr));
    } else {
      onChange([...selectedDates, dateStr]);
    }
  };

  const today = startOfDay(new Date());

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
      <div className="flex justify-between items-center mb-3">
        <button type="button" onClick={prevMonth} className="p-1 hover:bg-slate-100 rounded-lg text-slate-500">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-bold text-slate-800">
          {format(currentMonth, "yyyy년 M월")}
        </span>
        <button type="button" onClick={nextMonth} className="p-1 hover:bg-slate-100 rounded-lg text-slate-500">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center mb-2">
        {["일", "월", "화", "수", "목", "금", "토"].map(day => (
          <div key={day} className="text-[10px] font-bold text-slate-400">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: startPadding }).map((_, i) => (
          <div key={`empty-${i}`} className="h-8" />
        ))}
        {daysInMonth.map((day) => {
          const dateStr = format(day, "yyyy-MM-dd");
          const isSelected = selectedDates.includes(dateStr);
          const isPast = isBefore(day, today);

          return (
            <button
              key={dateStr}
              type="button"
              onClick={() => toggleDate(dateStr)}
              className={cn(
                "h-8 rounded-lg text-xs font-semibold flex items-center justify-center transition",
                isSelected
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-200"
                  : "text-slate-700 hover:bg-slate-100",
                getDay(day) === 0 && !isSelected && "text-rose-500", // 일요일 빨간색
                getDay(day) === 6 && !isSelected && "text-blue-500" // 토요일 파란색
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
      
      {selectedDates.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-bold text-slate-500">선택된 날짜 ({selectedDates.length}개)</span>
            <button 
              type="button" 
              onClick={() => onChange([])}
              className="text-[10px] text-rose-500 hover:underline font-bold"
            >
              전체 해제
            </button>
          </div>
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {selectedDates.sort().map(date => (
              <span key={date} className="px-2 py-1 bg-indigo-50 text-indigo-700 rounded text-[10px] font-semibold border border-indigo-100 flex items-center gap-1">
                {format(new Date(date), "M/d")}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
