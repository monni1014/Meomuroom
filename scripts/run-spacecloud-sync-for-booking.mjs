import { execFileSync, spawnSync } from "node:child_process";

const bookingNumber = process.argv[2]?.trim();
if (!/^\d{9,12}$/.test(bookingNumber || "")) {
  throw new Error("Usage: node scripts/run-spacecloud-sync-for-booking.mjs BOOKING_NUMBER [--headed] [--claim-only] [--dry-run]");
}

const inspectSaveRequest = process.argv.includes("--inspect-save-request");
const headed = process.argv.includes("--headed");
const claimOnly = process.argv.includes("--claim-only");
const dryRun = process.argv.includes("--dry-run");
const sql = `
  SELECT roomName, customerName, phone, startTime, endTime
  FROM Reservation
  WHERE emailId = 'naver:${bookingNumber}'
  LIMIT 1;
`;
const rows = JSON.parse(execFileSync("sqlite3", ["-json", "dev.db", sql], { encoding: "utf8" }));
const reservation = rows[0];
if (!reservation) throw new Error(`Reservation not found for booking ${bookingNumber}.`);

function kstParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

const start = kstParts(reservation.startTime);
const end = kstParts(reservation.endTime);
const dateValue = `${start.year}-${start.month}-${start.day}`;
const room = String(reservation.roomName || "").match(/([123])$/)?.[1];
if (!room) throw new Error(`Unsupported room for booking ${bookingNumber}.`);
if (`${end.year}-${end.month}-${end.day}` !== dateValue) {
  throw new Error(`Cross-day booking is not supported by this test runner: ${bookingNumber}.`);
}

const args = [
  "rpa/spacecloud-external-reservation.mjs",
  `--room=${room}`,
  `--date=${dateValue}`,
  `--start=${start.hour}:${start.minute}`,
  `--end=${end.hour}:${end.minute}`,
  "--mode=close",
  `--booking-number=${bookingNumber}`,
];
if (!dryRun) args.push("--apply");
if (reservation.customerName) args.push(`--customer-name=${reservation.customerName}`);
if (reservation.phone) args.push(`--phone=${reservation.phone}`);
if (inspectSaveRequest) args.push("--inspect-save-request");
if (claimOnly) args.push("--claim-only");

console.log(JSON.stringify({
  bookingNumber,
  room,
  date: dateValue,
  start: `${start.hour}:${start.minute}`,
  end: `${end.hour}:${end.minute}`,
  headed,
  claimOnly,
  dryRun,
  hasCustomerName: Boolean(reservation.customerName),
  hasPhone: Boolean(reservation.phone),
}, null, 2));

const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    ...(headed ? { RPA_HEADLESS: "false" } : {}),
  },
});
process.exit(result.status ?? 1);
