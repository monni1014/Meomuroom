import type { NotificationResendField } from "@/lib/reservation-notification-edit-policy";

const FIELD_LABELS: Record<NotificationResendField, string> = {
  phone: "전화번호",
  startTime: "시작시간",
  endTime: "종료시간",
  roomName: "이용 공간",
};

type ResendConfirmationResponse = {
  code?: string;
  changedFields?: NotificationResendField[];
};

export async function patchReservationWithNotificationConfirmation(
  reservationId: string,
  payload: Record<string, unknown>,
) {
  const sendPatch = (resendNotification?: boolean) => fetch(`/api/reservations/${reservationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      ...(typeof resendNotification === "boolean" ? { resendNotification } : {}),
    }),
  });

  let response = await sendPatch();
  if (response.status !== 409) return response;

  const conflict = await response.json().catch(() => ({})) as ResendConfirmationResponse;
  if (conflict.code !== "NOTIFICATION_RESEND_CONFIRMATION_REQUIRED") return response;

  const labels = [...new Set(conflict.changedFields || [])]
    .map((field) => FIELD_LABELS[field])
    .filter(Boolean)
    .join("·");
  const resendNotification = window.confirm(
    `${labels || "예약 정보"}이(가) 변경되었습니다.\n\n이미 안내문자가 처리된 예약입니다. 수정된 내용으로 안내문자를 다시 보낼까요?\n\n[확인] 예약 저장 후 재발송\n[취소] 예약만 저장`,
  );
  response = await sendPatch(resendNotification);
  return response;
}
