export const SPACECLOUD_ONLY_CLOSED_REASON =
  "SPACECLOUD_CLOSED_WITHOUT_NAVER_BOOKING";
export const SPACECLOUD_AND_NAVER_CLOSED_REASON =
  "SPACECLOUD_AND_NAVER_BOOKING_CLOSED";

type SpacecloudObservation = {
  competitorId: string;
  dateKey: string;
  hour: number;
  observedState: string;
  reason: string | null;
};

type NaverSlot = {
  dateKey: string;
  hour: number;
  state: string;
};

/**
 * A closed public SpaceCloud slot is not enough to infer a booking because
 * same-day cutoff and other sales policies also close slots. Synergy's
 * SpaceCloud booking is accepted only when the matching Naver slot is also
 * in the scanner's BOOKED state.
 */
export function crossCheckSynergySpacecloudWithNaver<
  T extends SpacecloudObservation,
>(observations: T[], naverSlots: NaverSlot[]): T[] {
  const bookedNaverKeys = new Set(
    naverSlots
      .filter((slot) => slot.state === "BOOKED")
      .map((slot) => `${slot.dateKey}|${slot.hour}`),
  );

  return observations.map((observation) => {
    if (
      observation.competitorId !== "synergy-spacecloud"
      || observation.observedState !== "BOOKED"
    ) {
      return observation;
    }

    const key = `${observation.dateKey}|${observation.hour}`;
    if (bookedNaverKeys.has(key)) {
      return {
        ...observation,
        reason: SPACECLOUD_AND_NAVER_CLOSED_REASON,
      };
    }

    return {
      ...observation,
      observedState: "POLICY_CLOSED",
      reason: SPACECLOUD_ONLY_CLOSED_REASON,
    } as T;
  });
}
