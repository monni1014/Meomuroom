type ReservationDeletionInput = {
  id: string;
  source: string;
  roomName: string;
  customerName: string | null;
  phone: string | null;
  startTime: Date;
  endTime: Date;
  usageLog?: object | null;
  messages?: object[];
  [key: string]: unknown;
};

function serializeSnapshot(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function normalizeDeletionSource(
  clientLabel: string | null,
  userAgent: string | null,
) {
  const client = clientLabel?.trim().slice(0, 80);
  const agent = userAgent?.trim().slice(0, 180);

  if (client && agent) return `${client} | ${agent}`;
  return client || agent || null;
}

export function buildReservationDeletionLogData(
  reservation: ReservationDeletionInput,
  deletedFrom: string | null,
) {
  const { usageLog = null, messages = [], ...reservationSnapshot } = reservation;

  return {
    reservationId: reservation.id,
    source: reservation.source,
    roomName: reservation.roomName,
    customerName: reservation.customerName,
    phone: reservation.phone,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    reservationSnapshot: serializeSnapshot(reservationSnapshot),
    usageLogSnapshot: usageLog ? serializeSnapshot(usageLog) : null,
    messageSnapshot: messages.length ? serializeSnapshot(messages) : null,
    deletedFrom,
  };
}
