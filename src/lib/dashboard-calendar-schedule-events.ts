export type DashboardCalendarScheduleEventType = "CREATED_TODAY" | "UPDATED_TODAY";

type DashboardCalendarScheduleSource = {
  createdAt: Date;
  updatedAt: Date;
};

function isWithinDay(value: Date, dayStart: Date, dayEnd: Date) {
  return value >= dayStart && value <= dayEnd;
}

export function decorateDashboardCalendarScheduleEvents<
  T extends DashboardCalendarScheduleSource,
>(schedules: T[], dayStart: Date, dayEnd: Date) {
  return schedules
    .map((schedule) => {
      const wasCreatedToday = isWithinDay(schedule.createdAt, dayStart, dayEnd);
      const wasUpdatedToday = isWithinDay(schedule.updatedAt, dayStart, dayEnd);
      const wasChangedAfterCreation = schedule.updatedAt.getTime() > schedule.createdAt.getTime();
      const isUpdatedToday = wasUpdatedToday && wasChangedAfterCreation;
      const dashboardEventAt = isUpdatedToday ? schedule.updatedAt : schedule.createdAt;

      return {
        ...schedule,
        dashboardEventType: (isUpdatedToday
          ? "UPDATED_TODAY"
          : "CREATED_TODAY") as DashboardCalendarScheduleEventType,
        dashboardEventAt: dashboardEventAt.toISOString(),
        isDashboardEventToday: isUpdatedToday || wasCreatedToday,
      };
    })
    .filter((schedule) => schedule.isDashboardEventToday)
    .sort((a, b) => Date.parse(b.dashboardEventAt) - Date.parse(a.dashboardEventAt));
}
