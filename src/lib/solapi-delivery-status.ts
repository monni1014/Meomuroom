export type SolapiDeliveryStatus = "SUBMITTED" | "CARRIER_ACCEPTED" | "DELIVERED" | "FAILED";

export function mapSolapiDeliveryStatus(statusCode: string): SolapiDeliveryStatus {
  if (statusCode === "2000") return "SUBMITTED";
  if (statusCode === "3000") return "CARRIER_ACCEPTED";
  if (statusCode === "4000") return "DELIVERED";
  return "FAILED";
}

export type SolapiHistoryMessage = {
  messageId?: string;
  groupId?: string;
  type?: string | null;
  to?: string | string[];
  from?: string | null;
  text?: string | null;
  statusCode?: string | null;
  reason?: string | null;
  dateCreated?: string;
  dateProcessed?: string | null;
  customFields?: Record<string, string> | null;
};

export type RecoveredReservationReminder = {
  found: true;
  status: SolapiDeliveryStatus;
  providerMessageId: string | null;
  channel: string;
  to: string;
  from: string;
  text: string;
  occurredAt: Date;
  error: string | null;
};

export type ReservationReminderLookupResult = RecoveredReservationReminder | { found: false };

function normalizePhone(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

function messageRecipientMatches(message: SolapiHistoryMessage, recipient: string) {
  const recipients = Array.isArray(message.to) ? message.to : [message.to || ""];
  return recipients.some((value) => normalizePhone(value) === recipient);
}

export function findReservationReminderInSolapiHistory(
  messages: SolapiHistoryMessage[],
  input: { reservationId: string; notificationAttemptId?: string | null; phone: string },
): ReservationReminderLookupResult {
  const recipient = normalizePhone(input.phone);
  const matches = messages
    .filter((message) => {
      if (!messageRecipientMatches(message, recipient)) return false;
      if (message.customFields?.reservationId !== input.reservationId) return false;
      if (input.notificationAttemptId) {
        return message.customFields?.notificationAttemptId === input.notificationAttemptId;
      }
      return true;
    })
    .sort((left, right) => (
      new Date(right.dateCreated || right.dateProcessed || 0).getTime()
      - new Date(left.dateCreated || left.dateProcessed || 0).getTime()
    ));

  const message = matches[0];
  if (!message) return { found: false };

  const statusCode = String(message.statusCode || "").trim();
  const status = statusCode ? mapSolapiDeliveryStatus(statusCode) : "SUBMITTED";
  const occurredAt = new Date(message.dateCreated || message.dateProcessed || Date.now());
  return {
    found: true,
    status,
    providerMessageId: message.messageId || message.groupId || null,
    channel: message.type || "SMS",
    to: recipient,
    from: normalizePhone(message.from),
    text: message.text || "",
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    error: status === "FAILED"
      ? `${message.reason || "문자 수신 실패"}${statusCode ? ` (${statusCode})` : ""}`
      : null,
  };
}
