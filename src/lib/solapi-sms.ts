import { SolapiMessageService } from "solapi";
import { getMessageTemplateForRoom } from "@/lib/message-templates";
import { getSelectedSolapiSenderNumber } from "@/lib/solapi-sender-setting";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";

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
  customerName: string | null;
  phone: string | null;
  roomName: string;
  startTime: Date;
  endTime: Date;
};

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

function isRealSendEnabled() {
  return env("SOLAPI_REAL_SEND").toLowerCase() === "true";
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

export async function sendReservationReminder(input: ReservationReminderInput): Promise<SendResult> {
  const to = normalizeKoreanPhone(input.phone);
  const reminder = await buildReservationReminder(input);
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

  const dryRun = !isRealSendEnabled();

  try {
    const from = await getSenderPhone();
    if (dryRun) {
      console.log(`[Solapi dry-run] ${channel} from=${from} to=${to} room=${input.roomName}\n${reminder.text}`);
      return { success: true, dryRun: true, channel, to, from, text: reminder.text };
    }

    const messageService = getSolapiService();
    const response = await messageService.send({
      to,
      from,
      text: reminder.text,
      ...(input.reservationId
        ? { customFields: { reservationId: input.reservationId } }
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
) {
  const now = new Date();
  const startTime = options.startTime || new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return sendReservationReminder({
    customerName: options.customerName ?? "테스트",
    phone: to,
    roomName: options.roomName || "머무룸1",
    startTime,
    endTime: options.endTime || new Date(startTime.getTime() + 2 * 60 * 60 * 1000),
  });
}
