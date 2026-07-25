export type ReservationPhoneState = {
  phone: string | null;
  syncedPhone?: string | null;
  phoneLocked: boolean;
};

function normalizedPhone(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

export function resolveRpaReservationPhoneState(
  existing: ReservationPhoneState,
  syncedPhone: string | null | undefined,
) {
  const nextSyncedPhone = syncedPhone || existing.syncedPhone || existing.phone;
  const phoneLocked = Boolean(
    existing.phoneLocked
    && normalizedPhone(existing.phone) !== normalizedPhone(nextSyncedPhone),
  );

  return {
    phone: phoneLocked ? existing.phone : nextSyncedPhone,
    syncedPhone: nextSyncedPhone,
    phoneLocked,
  };
}

export function shouldLockManuallyEditedPhone(
  existing: ReservationPhoneState,
  nextPhone: string | null | undefined,
) {
  const normalizedNextPhone = normalizedPhone(nextPhone);
  if (!normalizedNextPhone) return false;

  const originalPhone = existing.syncedPhone || (existing.phoneLocked ? null : existing.phone);
  if (!normalizedPhone(originalPhone)) return true;
  return normalizedNextPhone !== normalizedPhone(originalPhone);
}
