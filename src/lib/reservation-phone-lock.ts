export type ReservationPhoneState = {
  phone: string | null;
  phoneLocked: boolean;
};

export function resolveRpaReservationPhone(
  existing: ReservationPhoneState,
  syncedPhone: string | null | undefined,
) {
  if (existing.phoneLocked) return existing.phone;
  return syncedPhone || existing.phone;
}
