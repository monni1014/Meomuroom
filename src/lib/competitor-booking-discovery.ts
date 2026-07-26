export type ExistingCompetitorBookingState = {
  state: string;
  lastBookedAt: Date | null;
} | undefined;

/**
 * A closed slot is a new discovery when it was not previously known as booked,
 * or when legacy baseline data never produced a booking-discovery event.
 */
export function shouldCreateBookingDiscoveryEvent(
  nextState: string,
  current: ExistingCompetitorBookingState,
) {
  if (nextState !== "BOOKED") return false;
  return current?.state !== "BOOKED" || current.lastBookedAt === null;
}
