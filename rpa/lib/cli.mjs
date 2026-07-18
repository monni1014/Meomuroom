export function parseArgs(argv) {
  const args = {};

  for (const item of argv.slice(2)) {
    if (!item.startsWith("--")) continue;

    const [rawKey, ...valueParts] = item.slice(2).split("=");
    const key = rawKey.trim();
    const value = valueParts.length > 0 ? valueParts.join("=") : "true";
    args[key] = value;
  }

  return args;
}

export function requiredArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name}=...`);
  }
  return value;
}

export function parseHour(value, label, allow24 = false) {
  const match = /^(\d{1,2}):00$/.exec(value);
  if (!match) {
    throw new Error(`${label} must be HH:00. Example: 09:00`);
  }

  const hour = Number(match[1]);
  const maxHour = allow24 ? 24 : 23;
  if (!Number.isInteger(hour) || hour < 0 || hour > maxHour) {
    throw new Error(`${label} hour must be 00-${maxHour}`);
  }

  return hour;
}

export function parseRoom(value) {
  if (value === "1" || value === "room1" || value === "머무룸1") return "1";
  if (value === "2" || value === "room2" || value === "머무룸2") return "2";
  if (value === "3" || value === "room3" || value === "머무룸3") return "3";
  throw new Error("--room must be 1, 2, or 3");
}
