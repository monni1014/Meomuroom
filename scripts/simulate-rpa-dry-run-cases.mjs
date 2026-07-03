const NAVER_ROOM_PRODUCT_URL = {
  1: "https://partner.booking.naver.com/bizes/1473933/biz-items/6982316/detail",
  2: "https://partner.booking.naver.com/bizes/1473933/biz-items/7007523/detail",
};

const dates = [
  "2026-06-30",
  "2026-07-01",
  "2026-07-03",
  "2026-07-04",
  "2026-07-11",
  "2026-07-14",
  "2026-07-21",
  "2026-07-28",
  "2026-07-31",
  "2026-08-01",
];

const timeRanges = [
  ["01:00", "03:00"],
  ["02:00", "04:00"],
  ["09:00", "11:00"],
  ["10:00", "12:00"],
  ["11:00", "15:00"],
  ["13:00", "16:00"],
  ["14:00", "18:00"],
  ["17:00", "22:00"],
  ["18:00", "20:00"],
  ["19:00", "23:00"],
];

function hour(value) {
  const match = /^(\d{2}):00$/.exec(value);
  if (!match) throw new Error(`Invalid hour value: ${value}`);
  return Number(match[1]);
}

function validateCase(testCase) {
  const errors = [];
  const startHour = hour(testCase.start);
  const endHour = hour(testCase.end);

  if (![1, 2].includes(testCase.room)) errors.push("room must be 1 or 2");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(testCase.date)) errors.push("date must be YYYY-MM-DD");
  if (endHour <= startHour) errors.push("end must be after start");
  if (testCase.start.endsWith(":30") || testCase.end.endsWith(":30")) errors.push("platform RPA must use whole-hour times");
  if (testCase.command.some((arg) => arg === "--apply")) errors.push("dry-run command must not include --apply");
  if (testCase.source === "naver" && testCase.target === "spacecloud" && !testCase.command.some((arg) => arg.startsWith("--booking-number="))) {
    errors.push("SpaceCloud external reservation needs booking number marker");
  }
  if (testCase.source === "spacecloud" && testCase.target === "naver" && !testCase.command.some((arg) => arg.startsWith("--product-url="))) {
    errors.push("Naver slot dry-run needs exact product URL");
  }

  return errors;
}

function commandFor(testCase) {
  if (testCase.target === "spacecloud") {
    return [
      "node",
      "rpa/spacecloud-external-reservation.mjs",
      `--room=${testCase.room}`,
      `--date=${testCase.date}`,
      `--start=${testCase.start}`,
      `--end=${testCase.end}`,
      `--mode=${testCase.mode}`,
      `--booking-number=${testCase.bookingNumber}`,
      `--customer-name=${testCase.customerName}`,
      `--phone=${testCase.phone}`,
    ];
  }

  return [
    "node",
    "rpa/naver-toggle-slots.mjs",
    `--room=${testCase.room}`,
    `--date=${testCase.date}`,
    `--start=${testCase.start}`,
    `--end=${testCase.end}`,
    `--mode=${testCase.mode}`,
    `--product-url=${NAVER_ROOM_PRODUCT_URL[testCase.room]}`,
  ];
}

function buildCases() {
  const cases = [];
  const sources = ["naver", "spacecloud"];
  const statuses = ["confirmed", "cancelled"];

  for (let index = 0; cases.length < 100; index += 1) {
    const source = sources[index % sources.length];
    const status = statuses[Math.floor(index / sources.length) % statuses.length];
    const room = (index % 2) + 1;
    const date = dates[index % dates.length];
    const [start, end] = timeRanges[Math.floor(index / dates.length) % timeRanges.length];
    const target = source === "naver" ? "spacecloud" : "naver";
    const mode = status === "confirmed" ? "close" : "open";
    const bookingNumber = `${source.toUpperCase()}-${status.toUpperCase()}-${String(index + 1).padStart(3, "0")}`;

    const testCase = {
      id: index + 1,
      source,
      target,
      status,
      room,
      date,
      start,
      end,
      mode,
      bookingNumber,
      customerName: `시뮬${String(index + 1).padStart(3, "0")}`,
      phone: `010-10${String(index % 100).padStart(2, "0")}-${String(2000 + index).padStart(4, "0")}`,
    };
    testCase.command = commandFor(testCase);
    cases.push(testCase);
  }

  return cases;
}

const cases = buildCases();
const failures = [];

for (const testCase of cases) {
  const errors = validateCase(testCase);
  if (errors.length > 0) failures.push({ id: testCase.id, errors, testCase });
}

const summary = {
  total: cases.length,
  passed: cases.length - failures.length,
  failed: failures.length,
  byFlow: cases.reduce((acc, item) => {
    const key = `${item.source}->${item.target}:${item.status}:${item.mode}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  byRoom: cases.reduce((acc, item) => {
    acc[`room${item.room}`] = (acc[`room${item.room}`] || 0) + 1;
    return acc;
  }, {}),
  byTimeBand: cases.reduce((acc, item) => {
    const start = hour(item.start);
    const key = start < 6 ? "dawn" : start < 12 ? "morning" : start < 17 ? "afternoon" : "evening";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  sampleCommands: cases.slice(0, 8).map((item) => ({
    id: item.id,
    flow: `${item.source}->${item.target}`,
    status: item.status,
    command: item.command.join(" "),
  })),
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exit(1);
