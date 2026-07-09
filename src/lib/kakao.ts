import { SolapiMessageService } from "solapi";
import { getMessageTemplateForRoom } from "@/lib/message-templates";

type NotificationChannel = "SMS" | "KAKAO_ALIMTALK";

type SendResult = {
  success: boolean;
  dryRun: boolean;
  channel: NotificationChannel;
  to: string;
  messageId?: string | null;
  error?: string;
};

type ReservationReminderInput = {
  customerName: string | null;
  phone: string | null;
  roomName: string;
  startTime: Date;
  endTime: Date;
};

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function normalizePhone(phone: string | null | undefined) {
  return (phone || "").replace(/\D/g, "");
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

function getSenderPhone() {
  const sender = normalizePhone(env("SOLAPI_FROM") || env("OWNER_PHONE"));
  if (!sender) throw new Error("SOLAPI_FROM is required.");
  return sender;
}

function shouldUseAlimtalk() {
  return env("SOLAPI_MESSAGE_CHANNEL").toUpperCase() === "KAKAO_ALIMTALK";
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
  const to = normalizePhone(input.phone);
  if (!to) {
    return {
      success: false,
      dryRun: false,
      channel: shouldUseAlimtalk() ? "KAKAO_ALIMTALK" : "SMS",
      to: "",
      error: "Recipient phone number is missing.",
    };
  }

  const reminder = await buildReservationReminder(input);
  const channel: NotificationChannel = shouldUseAlimtalk() ? "KAKAO_ALIMTALK" : "SMS";
  const dryRun = !isRealSendEnabled();

  if (dryRun) {
    console.log(`[Solapi dry-run] ${channel} to=${to} room=${input.roomName}\n${reminder.text}`);
    return { success: true, dryRun: true, channel, to };
  }

  try {
    const from = getSenderPhone();
    const messageService = getSolapiService();
    const message =
      channel === "KAKAO_ALIMTALK"
        ? {
            to,
            from,
            kakaoOptions: {
              pfId: env("SOLAPI_KAKAO_PFID"),
              templateId: env("SOLAPI_KAKAO_RESERVATION_TEMPLATE_ID"),
              variables: {
                "#{고객명}": reminder.customerName,
                "#{예약일}": reminder.reservationDate,
                "#{예약시간}": reminder.reservationTime,
                "#{공간명}": reminder.roomName,
                "#{안내사항}": reminder.guide,
              },
            },
          }
        : {
            to,
            from,
            text: reminder.text,
          };

    if (channel === "KAKAO_ALIMTALK") {
      const kakaoOptions = message.kakaoOptions;
      if (!kakaoOptions?.pfId || !kakaoOptions?.templateId) {
        throw new Error("SOLAPI_KAKAO_PFID and SOLAPI_KAKAO_RESERVATION_TEMPLATE_ID are required for Kakao Alimtalk.");
      }
    }

    const response = await messageService.send(message);
    const messageId = response?.groupInfo?.groupId || null;
    return { success: true, dryRun: false, channel, to, messageId };
  } catch (error) {
    return {
      success: false,
      dryRun: false,
      channel,
      to,
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

export async function sendKakaoAlimtalk(name: string, startTime: string, phone: string): Promise<boolean> {
  const start = new Date(startTime);
  const result = await sendReservationReminder({
    customerName: name,
    phone,
    roomName: "머무룸1",
    startTime: start,
    endTime: new Date(start.getTime() + 2 * 60 * 60 * 1000),
  });
  return result.success;
}
