import fs from "node:fs";
import crypto from "node:crypto";
import webpush from "web-push";

const envPath = new URL("../.env", import.meta.url);
const subjectArg = process.argv.find((argument) => argument.startsWith("--subject="));
const subject = subjectArg?.slice("--subject=".length) || process.env.WEB_PUSH_SUBJECT || "";

if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
  throw new Error("Pass --subject=mailto:owner@example.com or an https URL.");
}

const original = fs.readFileSync(envPath, "utf8");
const current = Object.fromEntries(original.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!match) return [];
  return [[match[1], match[2].replace(/^['\"]|['\"]$/g, "")]];
}));
const vapidKeys = current.WEB_PUSH_VAPID_PUBLIC_KEY && current.WEB_PUSH_VAPID_PRIVATE_KEY
  ? null
  : webpush.generateVAPIDKeys();

const updates = {
  SOLAPI_WEBHOOK_SECRET: current.SOLAPI_WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex"),
  WEB_PUSH_VAPID_PUBLIC_KEY: current.WEB_PUSH_VAPID_PUBLIC_KEY || vapidKeys.publicKey,
  WEB_PUSH_VAPID_PRIVATE_KEY: current.WEB_PUSH_VAPID_PRIVATE_KEY || vapidKeys.privateKey,
  WEB_PUSH_SUBJECT: current.WEB_PUSH_SUBJECT || subject,
};

let next = original;
for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  next = pattern.test(next) ? next.replace(pattern, line) : `${next.trimEnd()}\n${line}\n`;
}

fs.writeFileSync(envPath, next, { encoding: "utf8", mode: 0o600 });
fs.chmodSync(envPath, 0o600);
console.log("Configured SOLAPI_WEBHOOK_SECRET and Web Push VAPID keys without exposing their values.");
