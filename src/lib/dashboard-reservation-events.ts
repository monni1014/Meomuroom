export type DashboardReservationEventType = "CREATED_TODAY" | "CANCELLED_TODAY";

type DashboardReservationSource = {
  createdAt: Date;
  cancelledAt: Date | null;
};

export function decorateDashboardReservationEvents<T extends DashboardReservationSource>(
  reservations: T[],
  dayStart: Date,
  dayEnd: Date,
) {
  return reservations
    .map((reservation) => {
      const isCancelledToday = Boolean(
        reservation.cancelledAt
        && reservation.cancelledAt >= dayStart
        && reservation.cancelledAt <= dayEnd,
      );
      const dashboardEventAt = isCancelledToday
        ? reservation.cancelledAt!
        : reservation.createdAt;

      return {
        ...reservation,
        dashboardEventType: (isCancelledToday
          ? "CANCELLED_TODAY"
          : "CREATED_TODAY") as DashboardReservationEventType,
        dashboardEventAt: dashboardEventAt.toISOString(),
      };
    })
    .sort((a, b) => Date.parse(b.dashboardEventAt) - Date.parse(a.dashboardEventAt));
}
