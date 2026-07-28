type MonthlyTableReservationStatus = {
  status: string;
  isNoShow: boolean;
  price: number;
};

export function shouldDisplayReservationInMonthlyTable(
  reservation: MonthlyTableReservationStatus,
) {
  if (reservation.status !== "CANCELLED") return true;
  if (reservation.isNoShow) return true;
  return reservation.price > 0;
}
