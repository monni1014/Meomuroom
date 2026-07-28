"use client";

// 시간 입력: 시 + 분 드롭다운.
// value/onChange 는 "HH:mm" 문자열. maxHour로 마지막 시를 늘릴 수 있다(기본 24).
// 24시 이상(25/26시 = 익일 새벽)은 종료시간 늦은 영업용. 마지막 시는 00분만 허용.
interface Props {
  value: string;
  onChange: (v: string) => void;
  maxHour?: number;
  minuteStep?: 10 | 30;
}

export default function TimeSelect({ value, onChange, maxHour = 24, minuteStep = 30 }: Props) {
  const hours = Array.from({ length: maxHour + 1 }, (_, i) => String(i).padStart(2, "0"));
  const parts = (value || "00:00").split(":");
  const h = parts[0] || "00";
  const currentMinute = parts[1] || "00";
  const atMax = parseInt(h, 10) >= maxHour; // 마지막 시는 00분만
  const minuteOptions = Array.from(
    { length: 60 / minuteStep },
    (_, index) => String(index * minuteStep).padStart(2, "0"),
  );
  const minute = atMax || !minuteOptions.includes(currentMinute) ? "00" : currentMinute;
  const cls =
    "text-sm p-2.5 rounded-xl border border-slate-200 outline-hidden focus:border-indigo-500 font-medium bg-white text-slate-800";

  return (
    <div className="flex items-center gap-1">
      <select value={h} onChange={(e) => onChange(`${e.target.value}:${minute}`)} className={cls}>
        {hours.map((hh) => (
          <option key={hh} value={hh}>{hh}시</option>
        ))}
      </select>
      <select value={minute} onChange={(e) => onChange(`${h}:${e.target.value}`)} className={cls}>
        {(atMax ? ["00"] : minuteOptions).map((mm) => (
          <option key={mm} value={mm}>{mm}분</option>
        ))}
      </select>
    </div>
  );
}
