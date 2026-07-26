import { reservationNotificationGroupKey } from "@/lib/reservation-notification-grouping";
import {
  resolveOnTimeExitTargetsWithGroupKey,
  type OnTimeExitCoreTarget,
} from "@/lib/on-time-exit-core";

export type OnTimeExitReservation = {
  id: string;
  roomName: string;
  phone: string | null;
  startTime: Date;
  endTime: Date;
};

export type OnTimeExitTarget<T extends OnTimeExitReservation> = OnTimeExitCoreTarget<T>;

export function resolveOnTimeExitTargets<T extends OnTimeExitReservation>(reservations: T[]) {
  return resolveOnTimeExitTargetsWithGroupKey(
    reservations,
    (reservation) => reservationNotificationGroupKey(reservation),
  );
}
