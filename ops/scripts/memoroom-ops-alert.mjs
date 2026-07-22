#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import webpush from "web-push";
import { SolapiMessageService } from "solapi";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const APP_ROOT = process.env.MEMOROOM_APP_ROOT || "/srv/memoroom/app";
dotenv.config({ path: `${APP_ROOT}/.env`, quiet: true });

const mode = process.argv[2] || "test";
const definitions = {
  test: {
    severity: "INFO",
    title: "서버 복구 알림 테스트",
    body: "머무룸 서버 자동복구 알림 경로가 정상입니다.",
    sms: "머무룸 서버 자동복구 알림 테스트입니다.",
  },
  "app-restart": {
    severity: "CRITICAL",
    title: "서버 앱 자동복구 시작",
    body: "앱 응답 지연이 반복되어 재시작합니다. 신규 예약을 수동 확인해주세요.",
    sms: "머무룸 서버 지연. 자동복구 중. 신규예약 확인 바랍니다.",
  },
  "app-recovered": {
    severity: "INFO",
    title: "서버 앱 자동복구 완료",
    body: "앱과 데이터베이스가 다시 정상 응답합니다. 최근 신규 예약을 확인해주세요.",
    sms: "머무룸 서버 자동복구 완료. 신규예약 확인 바랍니다.",
  },
  "server-boot": {
    severity: "WARNING",
    title: "서버 재부팅 감지",
    body: "서버가 다시 시작됐습니다. 복구 중 접수된 신규 예약을 확인해주세요.",
    sms: "머무룸 서버 재부팅 완료. 신규예약 확인 바랍니다.",
  },
};

const definition = definitions[mode];
if (!definition) {
  console.error(`Unknown ops alert mode: ${mode}`);
  process.exit(2);
}

function env(name) {
  return process.env[name]?.trim() || "";
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

let bootId = "unknown";
try {
  bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
} catch {
  bootId = new Date().toISOString();
}

let databaseRecorded = false;
let pushConfigured = false;
let pushSent = 0;
let pushFailed = 0;

const configuredDatabaseUrl = env("DATABASE_URL");
const databaseUrl = configuredDatabaseUrl.startsWith("file:./")
  ? `file:${APP_ROOT}/${configuredDatabaseUrl.slice("file:./".length)}`
  : configuredDatabaseUrl || `file:${APP_ROOT}/dev.db`;
const adapter = new PrismaLibSql({ url: databaseUrl });
const prisma = new PrismaClient({ adapter });

try {
  if (mode === "app-recovered") {
    await prisma.adminAlert.updateMany({
      where: { dedupeKey: "server-health-restart", resolved: false },
      data: { resolved: true },
    });
    databaseRecorded = true;
  } else {
    const dedupeKey = mode === "server-boot"
      ? `server-boot:${bootId}`
      : mode === "app-restart"
        ? "server-health-restart"
        : `server-alert-test:${bootId}`;
    await prisma.adminAlert.upsert({
      where: { dedupeKey },
      create: {
        type: "SERVER_HEALTH",
        severity: definition.severity,
        title: definition.title,
        message: definition.body,
        dedupeKey,
        resolved: mode === "test",
      },
      update: {
        severity: definition.severity,
        title: definition.title,
        message: definition.body,
        resolved: mode === "test",
        dismissedAt: null,
      },
    });
    databaseRecorded = true;
  }

  const publicKey = env("WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = env("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = env("WEB_PUSH_SUBJECT");
  pushConfigured = Boolean(publicKey && privateKey && subject);

  if (pushConfigured) {
    const setting = await prisma.appSetting.findUnique({ where: { key: "webpush.subscriptions" } });
    const subscriptions = setting ? JSON.parse(setting.value) : [];
    if (Array.isArray(subscriptions) && subscriptions.length > 0) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      await Promise.all(subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expirationTime,
              keys: subscription.keys,
            },
            JSON.stringify({
              title: definition.title,
              body: definition.body,
              url: "/",
              tag: `server-health-${mode}`,
            }),
            { TTL: 60 * 60, urgency: "high" },
          );
          pushSent += 1;
        } catch {
          pushFailed += 1;
        }
      }));
    }
  }
} catch (error) {
  console.error("Database or push alert failed:", error instanceof Error ? error.message : String(error));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

let smsAttempted = false;
let smsSubmitted = false;
let smsMessageId = null;
let smsError = null;

if (env("MEMOROOM_OPS_SMS_ENABLED").toLowerCase() === "true") {
  const apiKey = env("SOLAPI_API_KEY");
  const apiSecret = env("SOLAPI_API_SECRET");
  const from = normalizePhone(env("MEMOROOM_OPS_SMS_FROM"));
  const to = normalizePhone(env("MEMOROOM_OPS_SMS_TO"));
  if (apiKey && apiSecret && from.length >= 10 && to.length >= 10) {
    smsAttempted = true;
    try {
      const service = new SolapiMessageService(apiKey, apiSecret);
      const response = await service.send({ to, from, text: definition.sms }, { showMessageList: true });
      smsMessageId = response?.messageList?.[0]?.messageId || null;
      smsSubmitted = true;
    } catch (error) {
      const failure = error?.failedMessageList?.[0];
      smsError = failure?.statusMessage || (error instanceof Error ? error.message : String(error));
    }
  }
}

console.log(JSON.stringify({
  mode,
  databaseRecorded,
  pushConfigured,
  pushSent,
  pushFailed,
  smsAttempted,
  smsSubmitted,
  smsMessageId,
  smsError,
}));

if (smsAttempted && !smsSubmitted && pushSent === 0) process.exitCode = 1;
