import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" }),
});

const NAVER_PRODUCT_URLS = {
  1: "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail",
  2: "https://partner.booking.naver.com/bizes/1473933/biz-items/7007523/detail",
  3: "https://partner.booking.naver.com/bizes/1473933/biz-items/7858758/detail",
};

function parseArgs(argv) {
  const result = {};
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const [key, ...rest] = token.slice(2).split("=");
    result[key] = rest.length ? rest.join("=") : "true";
  }
  return result;
}

function validateMonth(value) {
  const match = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(value || "");
  if (!match) throw new Error("--month must be YYYY-MM");
  return value;
}

function parseTaggedJson(stdout, tag) {
  const marker = `${tag}=`;
  const lines = String(stdout || "").split(/\r?\n/);
  const line = [...lines].reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error(`${tag} was not found in RPA output.`);
  return JSON.parse(line.slice(marker.length));
}

async function runScanner(script, args, tag) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${script} timed out.`));
    }, 20 * 60 * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${script} exited with code ${code}.`));
      else resolve(output);
    });
  });
  return parseTaggedJson(stdout, tag);
}

function naverScanRanges(month, fromDay, throughDay) {
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(nowParts.map((part) => [part.type, part.value]));
  const currentMonth = `${value.year}-${value.month}`;
  if (month !== currentMonth) return [{ start: fromDay, end: throughDay }];

  const year = Number(value.year);
  const monthNumber = Number(value.month);
  const currentDay = Number(value.day);
  const weekday = new Date(Date.UTC(year, monthNumber - 1, currentDay)).getUTCDay();
  const monday = currentDay - ((weekday + 6) % 7);
  if (fromDay < monday && monday <= throughDay) {
    return [
      { start: fromDay, end: monday - 1 },
      { start: monday, end: throughDay },
    ];
  }
  return [{ start: fromDay, end: throughDay }];
}

async function scanRoom(room, month, fromDay, throughDay) {
  console.log(`[Fake block audit] 머무룸${room} 네이버 검사를 시작합니다.`);
  const naverDays = [];
  for (const range of naverScanRanges(month, fromDay, throughDay)) {
    const part = await runScanner(
      "rpa/naver-toggle-slots.mjs",
      [
        `--room=${room}`,
        `--scan-month=${month}`,
        `--scan-start-day=${range.start}`,
        `--scan-end-day=${range.end}`,
        `--product-url=${NAVER_PRODUCT_URLS[room]}`,
      ],
      "NAVER_MONTH_SCAN_JSON",
    );
    naverDays.push(...part.days);
  }

  console.log(`[Fake block audit] 머무룸${room} 스클 검사를 시작합니다.`);
  const spacecloud = await runScanner(
    "rpa/spacecloud-external-reservation.mjs",
    [`--room=${room}`, `--scan-month=${month}`],
    "SPACECLOUD_MONTH_SCAN_JSON",
  );

  return { room, naver: { month, days: naverDays }, spacecloud };
}

function kstDate(dateValue, hour) {
  return new Date(`${dateValue}T${String(hour).padStart(2, "0")}:00:00+09:00`);
}

function monthRange(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    start: new Date(`${month}-01T00:00:00+09:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`),
  };
}

function reservationCovers(reservations, roomName, start, end) {
  return reservations.some((reservation) => (
    reservation.roomName === roomName
    && reservation.status !== "CANCELLED"
    && reservation.startTime < end
    && reservation.endTime > start
  ));
}

function spaceCloudCovers(day, hour) {
  return (day?.intervals || []).some((interval) => interval.start <= hour && interval.end >= hour + 1);
}

function groupCandidateHours(room, dateValue, hours) {
  if (!hours.length) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const result = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (const hour of sorted.slice(1)) {
    if (hour === previous + 1) {
      previous = hour;
      continue;
    }
    result.push({ room, dateValue, startHour: start, endHour: previous + 1 });
    start = hour;
    previous = hour;
  }
  result.push({ room, dateValue, startHour: start, endHour: previous + 1 });
  return result;
}

function formatCandidateMessage(candidate) {
  const [, month, day] = candidate.dateValue.split("-");
  return `머무룸${candidate.room} · ${Number(month)}월 ${Number(day)}일 · ${candidate.startHour}시~${candidate.endHour}시`;
}

function candidateKey(candidate) {
  return `${candidate.room}:${candidate.dateValue}:${candidate.startHour}:${candidate.endHour}`;
}

async function persistCandidates(month, candidates, fromDay, throughDay) {
  const start = new Date(`${month}-${String(fromDay).padStart(2, "0")}T00:00:00+09:00`);
  const end = new Date(new Date(`${month}-${String(throughDay).padStart(2, "0")}T00:00:00+09:00`).getTime() + 86_400_000);
  const foundKeys = new Set(candidates.map(candidateKey));
  const existing = await prisma.fakeBlockCandidate.findMany({
    where: { startTime: { gte: start, lt: end } },
  });

  for (const row of existing) {
    const dateValue = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(row.startTime);
    const startHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      hourCycle: "h23",
    }).format(row.startTime));
    const endHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      hourCycle: "h23",
    }).format(row.endTime)) || 24;
    const room = Number(String(row.roomName).replace(/\D/g, ""));
    if (foundKeys.has(candidateKey({ room, dateValue, startHour, endHour }))) continue;

    if (row.status !== "PENDING") continue;

    await prisma.fakeBlockCandidate.update({
      where: { id: row.id },
      data: { status: "RESOLVED" },
    });
    await prisma.adminAlert.updateMany({
      where: { dedupeKey: `fake-block:${row.id}`, resolved: false },
      data: { resolved: true },
    });
  }

  const persisted = [];
  for (const candidate of candidates) {
    const roomName = `머무룸${candidate.room}`;
    const startTime = kstDate(candidate.dateValue, candidate.startHour);
    const endTime = kstDate(candidate.dateValue, candidate.endHour);
    const prior = await prisma.fakeBlockCandidate.findUnique({
      where: { roomName_startTime_endTime: { roomName, startTime, endTime } },
    });
    const row = await prisma.fakeBlockCandidate.upsert({
      where: { roomName_startTime_endTime: { roomName, startTime, endTime } },
      create: { roomName, startTime, endTime, status: "PENDING" },
      update: prior?.status === "RESOLVED" ? { status: "PENDING" } : {},
    });

    if (row.status === "PENDING") {
      await prisma.adminAlert.upsert({
        where: { dedupeKey: `fake-block:${row.id}` },
        create: {
          type: "FAKE_BLOCK_CANDIDATE",
          severity: "WARNING",
          title: "뻥카 발견 · 확인 필요",
          message: formatCandidateMessage(candidate),
          dedupeKey: `fake-block:${row.id}`,
        },
        update: {
          title: "뻥카 발견 · 확인 필요",
          message: formatCandidateMessage(candidate),
          resolved: false,
          dismissedAt: null,
        },
      });
    }
    persisted.push({ ...candidate, id: row.id, status: row.status });
  }
  return persisted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const month = validateMonth(args.month);
  const range = monthRange(month);
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const fromDay = Math.max(1, Math.min(daysInMonth, Number(args["from-day"] || 1)));
  const throughDay = Math.max(fromDay, Math.min(daysInMonth, Number(args["through-day"] || daysInMonth)));
  const reservations = await prisma.reservation.findMany({
    where: {
      status: { not: "CANCELLED" },
      startTime: { lt: range.end },
      endTime: { gt: range.start },
    },
    select: { roomName: true, startTime: true, endTime: true, status: true },
  });

  const scans = [];
  for (const room of [1, 2, 3]) {
    scans.push(await scanRoom(room, month, fromDay, throughDay));
  }

  const candidates = [];
  for (const scan of scans) {
    const spaceCloudDays = new Map(scan.spacecloud.days.map((day) => [day.date, day]));
    for (const day of scan.naver.days) {
      const candidateHours = [];
      for (let hour = 8; hour < 24; hour += 1) {
        if (day.hours[String(hour)] !== "close") continue;
        if (spaceCloudCovers(spaceCloudDays.get(day.date), hour)) continue;
        const start = kstDate(day.date, hour);
        const end = kstDate(day.date, hour + 1);
        if (reservationCovers(reservations, `머무룸${scan.room}`, start, end)) continue;
        candidateHours.push(hour);
      }
      candidates.push(...groupCandidateHours(scan.room, day.date, candidateHours));
    }
  }

  const persisted = await persistCandidates(month, candidates, fromDay, throughDay);
  console.log(`FAKE_BLOCK_AUDIT_JSON=${JSON.stringify({
    ok: true,
    month,
    fromDay,
    throughDay,
    readOnly: true,
    candidates: persisted,
  })}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
