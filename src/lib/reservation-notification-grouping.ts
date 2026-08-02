import { getKstDateKey } from "@/lib/kst-time";
import { isValidKoreanMobilePhone, normalizeKoreanPhone } from "@/lib/phone-number";

export type ReservationNotificationGroupMember = {
  id: string;
  roomName: string;
  phone: string | null;
  startTime: Date;
};

export type ReservationNotificationContinuityMember = ReservationNotificationGroupMember & {
  endTime: Date;
};

export function reservationNotificationGroupKey(
  reservation: ReservationNotificationGroupMember,
) {
  const phone = normalizeKoreanPhone(reservation.phone);
  if (!isValidKoreanMobilePhone(phone)) return null;

  return [
    getKstDateKey(reservation.startTime),
    reservation.roomName.trim(),
    phone,
  ].join("|");
}

export function isContiguousReservationNotificationExtension(
  previous: ReservationNotificationContinuityMember,
  next: ReservationNotificationContinuityMember,
) {
  const previousPhone = normalizeKoreanPhone(previous.phone);
  const nextPhone = normalizeKoreanPhone(next.phone);
  if (!isValidKoreanMobilePhone(previousPhone) || !isValidKoreanMobilePhone(nextPhone)) {
    return false;
  }

  return previous.roomName.trim() === next.roomName.trim()
    && previousPhone === nextPhone
    && previous.endTime.getTime() === next.startTime.getTime();
}

export function buildReservationNotificationGroups<T extends ReservationNotificationGroupMember>(
  reservations: T[],
) {
  const membersByKey = new Map<string, T[]>();

  for (const reservation of reservations) {
    const key = reservationNotificationGroupKey(reservation);
    if (!key) continue;
    const members = membersByKey.get(key) || [];
    members.push(reservation);
    membersByKey.set(key, members);
  }

  for (const members of membersByKey.values()) {
    members.sort((left, right) => (
      left.startTime.getTime() - right.startTime.getTime()
      || left.id.localeCompare(right.id)
    ));
  }

  return membersByKey;
}
