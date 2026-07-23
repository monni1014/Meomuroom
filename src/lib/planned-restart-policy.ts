export type PlannedRestartActivity = {
  queue: {
    queued: number;
    active: number;
    activeOrCoolingDown: number;
    running: boolean;
    slotRecheckRunning: boolean;
    naverStatusReconcileRunning: boolean;
  };
  competitorScanRunning: boolean;
  sendingCustomerNotifications: number;
};

export function plannedRestartBusyReasons(activity: PlannedRestartActivity) {
  const reasons: string[] = [];
  if (activity.queue.running) reasons.push("reservation-rpa-running");
  if (activity.queue.queued > 0) reasons.push("reservation-rpa-queued");
  if (activity.queue.active > 0) reasons.push("reservation-rpa-active");
  if (activity.queue.slotRecheckRunning) reasons.push("slot-recheck-running");
  if (activity.queue.naverStatusReconcileRunning) reasons.push("naver-status-reconcile-running");
  if (activity.competitorScanRunning) reasons.push("competitor-scan-running");
  if (activity.sendingCustomerNotifications > 0) reasons.push("customer-sms-sending");
  return reasons;
}
