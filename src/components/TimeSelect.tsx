"use client";

// 시간 입력: 시(00~23) + 분(00/30 2개만) 드롭다운.
// value/onChange 는 "HH:mm" 문자열 형식.
interface Props {
  value: string;
  onChange: (v: string) => void;
}

const HOURS = Array.from({ length: 25 }, (_, i) => String(i).padStart(2, "0"));

export default function TimeSelect({ value, onChange }: Props) {
  const parts = (value || "00:00").split(":");
  const h = parts[0] || "00";
  // 24시는 00분만 허용
  const minute = h === "24" ? "00" : (parts[1] === "30" ? "30" : "00");
  const cls =
    "text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white text-slate-800";

  return (
    <div className="flex items-center gap-1">
      <select value={h} onChange={(e) => onChange(`${e.target.value}:${minute}`)} className={cls}>
        {HOURS.map((hh) => (
          <option key={hh} value={hh}>{hh}시</option>
        ))}
      </select>
      <select value={minute} onChange={(e) => onChange(`${h}:${e.target.value}`)} className={cls}>
        <option value="00">00분</option>
        {h !== "24" && <option value="30">30분</option>}
      </select>
    </div>
  );
}
