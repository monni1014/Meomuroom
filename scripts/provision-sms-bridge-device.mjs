import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() : "";
}

function normalizePhone(value) {
  let digits = (value || "").replace(/\D/g, "");
  if (digits.startsWith("0082")) digits = digits.slice(2);
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  return digits;
}

const name = argument("name");
const phoneNumber = normalizePhone(argument("phone"));
if (!name || phoneNumber.length < 9) {
  console.error('Usage: node scripts/provision-sms-bridge-device.mjs --name "사장님 S25" --phone 01012345678');
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL || "file:./dev.db" }),
});

try {
  const device = await prisma.smsBridgeDevice.upsert({
    where: { phoneNumber },
    create: { name, phoneNumber, tokenHash },
    update: { name, tokenHash, enabled: true },
  });
  console.log(JSON.stringify({
    id: device.id,
    name: device.name,
    phoneNumber: device.phoneNumber,
    token,
    webhookPath: `/api/sms/inbound?token=${token}`,
    warning: "This token is shown only now. Do not share it or commit it.",
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
