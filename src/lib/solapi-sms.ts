import { SolapiMessageService } from "solapi";
import { getMessageTemplateForRoom } from "@/lib/message-templates";
import { getSelectedSolapiSenderNumber } from "@/lib/solapi-sender-setting";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";
import { reservationMessageSubject } from "@/lib/reservation-message-subject";
import { findSolapiTextEncodingIssue } from "@/lib/solapi-text-safety";
import {
  findReservationReminderInSolapiHistory,
  type ReservationReminderLookupResult,
  type SolapiHistoryMessage,
} from "@/lib/solapi-delivery-status";

type NotificationChannel = "SMS";

export type SendResult = {
  success: boolean;
  dryRun: boolean;
  channel: NotificationChannel;
  to: string;
  from: string;
  text: string;
  messageId?: string | null;
  error?: string;
};

type ReservationReminderInput = {
  reservationId?: string;
  notificationAttemptId?: string;
  customerName: string | null;
  phone: string | null;
  roomName: string;
  startTime: Date;
  endTime: Date;
};

type SendOptions = {
  forceRealSend?: boolean;
  forceDryRun?: boolean;
};

const SOLAPI_SMS_MAX_BYTES = 90;

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function formatKstDate(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(date);
}

function formatKstTime(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function getSolapiService() {
  const apiKey = env("SOLAPI_API_KEY");
  const apiSecret = env("SOLAPI_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error("SOLAPI_API_KEY and SOLAPI_API_SECRET are required.");
  }
  return new SolapiMessageService(apiKey, apiSecret);
}

async function getSenderPhone() {
  const sender = await getSelectedSolapiSenderNumber();
  if (!sender) throw new Error("문자 발신번호가 설정되지 않았습니다.");
  return sender;
}

function isRealSendEnabledFor(recipient: string) {
  if (env("SOLAPI_REAL_SEND").toLowerCase() !== "true") return false;
  const allowlist = env("SOLAPI_REAL_SEND_ALLOWLIST")
    .split(",")
    .map(normalizeKoreanPhone)
    .filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(recipient);
}

function getSolapiErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const failedMessageList = (error as { failedMessageList?: Array<{ statusMessage?: string; statusCode?: string }> })
      .failedMessageList;
    const firstFailure = failedMessageList?.[0];
    if (firstFailure?.statusMessage) {
      return firstFailure.statusCode
        ? `${firstFailure.statusMessage} (${firstFailure.statusCode})`
        : firstFailure.statusMessage;
    }
    return error.message;
  }
  return String(error);
}

function getSolapiSmsByteLength(text: string) {
  return Array.from(text).reduce(
    (total, character) => total + (/^[\x00-\x7F]$/.test(character) ? 1 : 2),
    0,
  );
}

export async function lookupReservationReminderDelivery(input: {
  reservationId: string;
  notificationAttemptId?: string | null;
  phone: string;
  now?: Date;
}): Promise<ReservationReminderLookupResult> {
  const recipient = normalizeKoreanPhone(input.phone);
  if (!isValidKoreanMobilePhone(recipient)) return { found: false };

  const now = input.now || new Date();
  const response = await getSolapiService().getMessages({
    to: recipient,
    limit: 100,
    dateType: "CREATED",
    startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    endDate: new Date(now.getTime() + 5 * 60 * 1000),
  });
  return findReservationReminderInSolapiHistory(
    Object.values(response.messageList || {}) as SolapiHistoryMessage[],
    input,
  );
}

export async function buildReservationReminder(input: ReservationReminderInput) {
  const customerName = input.customerName?.trim() || "고객";
  const reservationDate = formatKstDate(input.startTime);
  const reservationTime = `${formatKstTime(input.startTime)} - ${formatKstTime(input.endTime)}`;
  const guide = await getMessageTemplateForRoom(input.roomName);

  return {
    customerName,
    reservationDate,
    reservationTime,
    roomName: input.roomName,
    guide,
    text: guide,
  };
}

export async function sendReservationReminder(
  input: ReservationReminderInput,
  options: SendOptions = {},
): Promise<SendResult> {
  const to = normalizeKoreanPhone(input.phone);
  const reminder = await buildReservationReminder(input);
  const subject = reservationMessageSubject(input.roomName);
  const channel: NotificationChannel = "SMS";
  if (!isValidKoreanMobilePhone(to)) {
    return {
      success: false,
      dryRun: false,
      channel,
      to: "",
      from: "",
      text: reminder.text,
      error: to
        ? "Recipient mobile phone number is invalid."
        : "Recipient phone number is missing.",
    };
  }

  const dryRun = options.forceDryRun === true
    || (!options.forceRealSend && !isRealSendEnabledFor(to));

  const encodingIssue = findSolapiTextEncodingIssue(reminder.text);
  if (encodingIssue) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text: reminder.text,
      error: `Solapi 발송 차단: ${encodingIssue}`,
    };
  }

  try {
    const from = await getSenderPhone();
    if (dryRun) {
      console.log(`[Solapi dry-run] ${channel} from=${from} to=${to} room=${input.roomName} subject=${subject}\n${reminder.text}`);
      return { success: true, dryRun: true, channel, to, from, text: reminder.text };
    }

    const messageService = getSolapiService();
    const response = await messageService.send({
      to,
      from,
      subject,
      text: reminder.text,
      ...(input.reservationId
        ? {
            customFields: {
              reservationId: input.reservationId,
              ...(input.notificationAttemptId
                ? { notificationAttemptId: input.notificationAttemptId }
                : {}),
            },
          }
        : {}),
    }, { showMessageList: true });
    const messageId = response?.messageList?.[0]?.messageId || response?.groupInfo?.groupId || null;
    return { success: true, dryRun: false, channel, to, from, text: reminder.text, messageId };
  } catch (error) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text: reminder.text,
      error: getSolapiErrorMessage(error),
    };
  }
}

export async function sendTestSms(
  to = env("SOLAPI_TEST_TO") || env("OWNER_PHONE"),
  options: Partial<ReservationReminderInput> = {},
  sendOptions: SendOptions = {},
) {
  const now = new Date();
  const startTime = options.startTime || new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return sendReservationReminder({
    reservationId: options.reservationId,
    notificationAttemptId: options.notificationAttemptId,
    customerName: options.customerName ?? "테스트",
    phone: to,
    roomName: options.roomName || "머무룸1",
    startTime,
    endTime: options.endTime || new Date(startTime.getTime() + 2 * 60 * 60 * 1000),
  }, sendOptions);
}

export async function sendOperationalAlertSms(input: {
  to: string;
  text: string;
}): Promise<SendResult> {
  const to = normalizeKoreanPhone(input.to);
  const text = input.text.trim();
  const channel: NotificationChannel = "SMS";

  if (!isValidKoreanMobilePhone(to)) {
    return {
      success: false,
      dryRun: false,
      channel,
      to: "",
      from: "",
      text,
      error: "Operational alert recipient phone number is invalid.",
    };
  }

  if (!text) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text,
      error: "Operational alert text is empty.",
    };
  }

  const encodingIssue = findSolapiTextEncodingIssue(text);
  if (encodingIssue) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text,
      error: `Solapi 발송 차단: ${encodingIssue}`,
    };
  }

  const messageBytes = getSolapiSmsByteLength(text);
  if (messageBytes > SOLAPI_SMS_MAX_BYTES) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text,
      error: `Operational alert exceeds the ${SOLAPI_SMS_MAX_BYTES}-byte SMS limit (${messageBytes} bytes).`,
    };
  }

  try {
    let from = await getSenderPhone();
    const ownerPhone = normalizeKoreanPhone(env("OWNER_PHONE"));

    // A registered alternate sender avoids sending an operational warning
    // from and to the same phone number when the selected sender is the wife.
    if (from === to && isValidKoreanMobilePhone(ownerPhone) && ownerPhone !== to) {
      from = ownerPhone;
    }

    if (!isRealSendEnabledFor(to)) {
      console.log(`[Solapi operational dry-run] from=${from} to=${to} text=${text}`);
      return { success: true, dryRun: true, channel, to, from, text };
    }

    const response = await getSolapiService().send({
      to,
      from,
      text,
      type: "SMS",
      customFields: { messageCategory: "operational" },
    }, { showMessageList: true });
    const messageId = response?.messageList?.[0]?.messageId || response?.groupInfo?.groupId || null;
    return { success: true, dryRun: false, channel, to, from, text, messageId };
  } catch (error) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
      from: "",
      text,
      error: getSolapiErrorMessage(error),
    };
  }
}
