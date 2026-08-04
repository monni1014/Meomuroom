type ReservationMatchCandidate = {
  emailId?: string | null;
  source: string;
  roomName: string;
  customerName?: string | null;
  startTime: Date;
  endTime: Date;
  status: string;
  memo?: string | null;
};

type ReservationMatchInput = {
  source: string;
  messageId: string;
  canonicalEmailId?: string | null;
  roomName: string;
  customerName?: string | null;
  startTime: Date;
  endTime: Date;
  isCancelled: boolean;
  allowUniqueCrossRoomCancellation?: boolean;
};

function sameInstant(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function sameCustomer(left?: string | null, right?: string | null) {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/**
 * Chooses the reservation row that an incoming RPA email is allowed to update.
 * A new booking must never revive a previously cancelled canonical booking row.
 * SpaceCloud cancellation emails may omit the reservation link. In that case,
 * a detached RPA placeholder can be recovered across rooms, but an already
 * confirmed reservation must never be guessed: one customer may have multiple
 * reservations for the same time in different rooms.
 */
export function selectReservationMatch<T extends ReservationMatchCandidate>(
  candidates: T[],
  input: ReservationMatchInput,
) {
  const sourceCandidates = candidates.filter((candidate) => candidate.source === input.source);

  if (input.canonicalEmailId) {
    const canonical = sourceCandidates.find((candidate) => candidate.emailId === input.canonicalEmailId);
    if (canonical) return canonical;
  }

  const messageRow = sourceCandidates.find((candidate) => candidate.emailId === input.messageId);
  if (messageRow) return messageRow;

  const exactRoomAndTime = sourceCandidates.filter((candidate) => (
    candidate.roomName === input.roomName
    && sameInstant(candidate.startTime, input.startTime)
    && sameInstant(candidate.endTime, input.endTime)
  ));
  const activeExact = exactRoomAndTime.filter((candidate) => candidate.status !== "CANCELLED");

  const exactCustomer = activeExact.find((candidate) => sameCustomer(candidate.customerName, input.customerName));
  if (exactCustomer) return exactCustomer;
  if (activeExact.length === 1) return activeExact[0];

  if (input.isCancelled && input.allowUniqueCrossRoomCancellation) {
    const crossRoom = sourceCandidates.filter((candidate) => (
      candidate.memo?.includes("[RPA_PENDING]")
      && sameInstant(candidate.startTime, input.startTime)
      && sameInstant(candidate.endTime, input.endTime)
      && sameCustomer(candidate.customerName, input.customerName)
    ));
    if (crossRoom.length === 1) return crossRoom[0];
  }

  return null;
}
