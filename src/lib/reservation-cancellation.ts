type CancellationState = {
  status: string;
  cancelledAt?: Date | null;
};

/**
 * Keep the first timestamp of the transition into CANCELLED. Reprocessing the
 * same cancellation must not make an old cancellation look new again.
 */
export function resolveReservationCancellationState(
  existing: CancellationState | null | undefined,
  nextStatus: string,
  occurredAt = new Date(),
) {
  if (nextStatus !== "CANCELLED") {
    return { cancelledAt: null };
  }

  if (existing?.status === "CANCELLED" && existing.cancelledAt) {
    return { cancelledAt: existing.cancelledAt };
  }

  return { cancelledAt: occurredAt };
}
