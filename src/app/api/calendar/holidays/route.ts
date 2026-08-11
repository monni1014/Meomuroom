import { getHolidayPreset } from "@hyunbinseo/holidays-kr";

const KOREAN_HOLIDAY_CALENDAR_URL =
  "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";

type HolidayMap = Record<string, readonly string[]>;

function parsePublicHolidays(calendarText: string, requestedYears: Set<string>): HolidayMap {
  const unfolded = calendarText.replace(/\r?\n[ \t]/g, "");
  const holidays = new Map<string, Set<string>>();

  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const dateValue = block.match(/^DTSTART;VALUE=DATE:(\d{8})$/m)?.[1];
    const summary = block.match(/^SUMMARY:(.+)$/m)?.[1]?.trim();
    const description = block.match(/^DESCRIPTION:(.+)$/m)?.[1]?.trim();
    if (!dateValue || !summary || !description?.startsWith("공휴일")) continue;

    const year = dateValue.slice(0, 4);
    if (!requestedYears.has(year)) continue;

    const date = `${year}-${dateValue.slice(4, 6)}-${dateValue.slice(6, 8)}`;
    const names = holidays.get(date) ?? new Set<string>();
    names.add(summary.replace(/\\,/g, ",").replace(/\\;/g, ";"));
    holidays.set(date, names);
  }

  return Object.fromEntries(
    Array.from(holidays.entries()).map(([date, names]) => [date, Array.from(names)])
  );
}

async function getBundledFallback(years: string[]): Promise<HolidayMap> {
  const presets = await Promise.all(
    years.map(async (year) => {
      try {
        return await getHolidayPreset(year);
      } catch {
        return {} as HolidayMap;
      }
    })
  );

  return Object.assign({}, ...presets);
}

export async function GET(request: Request) {
  const requestedYears = Array.from(
    new Set(
      new URL(request.url).searchParams
        .get("years")
        ?.split(",")
        .filter((year) => /^20\d{2}$/.test(year)) ?? []
    )
  ).slice(0, 3);

  if (requestedYears.length === 0) {
    return Response.json({ holidays: {} });
  }

  const fallback = await getBundledFallback(requestedYears);

  try {
    const response = await fetch(KOREAN_HOLIDAY_CALENDAR_URL, {
      next: { revalidate: 60 * 60 * 24 },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Google holiday calendar ${response.status}`);

    const official = parsePublicHolidays(await response.text(), new Set(requestedYears));
    return Response.json(
      { holidays: { ...fallback, ...official }, source: "google-calendar" },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } }
    );
  } catch {
    return Response.json(
      { holidays: fallback, source: "bundled-fallback" },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=86400" } }
    );
  }
}
