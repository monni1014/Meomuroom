export type TailscaleDeviceMonitorState = {
  registered: boolean;
  boundDnsName: string | null;
  boundHostName: string | null;
  lastCheckedAt: string;
  lastOnlineAt: string | null;
  offlineSince: string | null;
  consecutiveOffline: number;
  alertDedupeKey: string | null;
  alertHandledAt: string | null;
  smsSentAt: string | null;
  reminderSmsSentAt: string | null;
  lastSmsError: string | null;
  lastRecoveredAt: string | null;
};

export type TailscaleDeviceObservation = {
  registered: boolean;
  online: boolean;
  dnsName?: string | null;
  hostName?: string | null;
};

export type TailscaleDeviceDecision = {
  state: TailscaleDeviceMonitorState;
  shouldAlert: boolean;
  shouldRemind: boolean;
  recoveredAlertKey: string | null;
};

function validIsoTime(value: string | null | undefined) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function evaluateTailscaleDeviceObservation(input: {
  deviceId: string;
  now: Date;
  offlineThresholdMinutes: number;
  reminderDelayMinutes?: number;
  previous?: Partial<TailscaleDeviceMonitorState> | null;
  observation: TailscaleDeviceObservation;
}): TailscaleDeviceDecision {
  const nowIso = input.now.toISOString();
  const previous = input.previous || {};
  const registered = input.observation.registered || previous.registered === true;
  const boundDnsName = input.observation.dnsName || previous.boundDnsName || null;
  const boundHostName = input.observation.hostName || previous.boundHostName || null;

  if (!registered) {
    return {
      state: {
        registered: false,
        boundDnsName,
        boundHostName,
        lastCheckedAt: nowIso,
        lastOnlineAt: previous.lastOnlineAt || null,
        offlineSince: null,
        consecutiveOffline: 0,
        alertDedupeKey: null,
        alertHandledAt: null,
        smsSentAt: null,
        reminderSmsSentAt: null,
        lastSmsError: null,
        lastRecoveredAt: previous.lastRecoveredAt || null,
      },
      shouldAlert: false,
      shouldRemind: false,
      recoveredAlertKey: null,
    };
  }

  if (input.observation.online) {
    const recoveredAlertKey = previous.alertDedupeKey || null;
    return {
      state: {
        registered: true,
        boundDnsName,
        boundHostName,
        lastCheckedAt: nowIso,
        lastOnlineAt: nowIso,
        offlineSince: null,
        consecutiveOffline: 0,
        alertDedupeKey: null,
        alertHandledAt: null,
        smsSentAt: null,
        reminderSmsSentAt: null,
        lastSmsError: null,
        lastRecoveredAt: previous.offlineSince ? nowIso : previous.lastRecoveredAt || null,
      },
      shouldAlert: false,
      shouldRemind: false,
      recoveredAlertKey,
    };
  }

  const offlineSince = previous.offlineSince || nowIso;
  const offlineSinceMs = validIsoTime(offlineSince) ?? input.now.getTime();
  const thresholdMs = Math.max(1, input.offlineThresholdMinutes) * 60_000;
  const thresholdReached = input.now.getTime() - offlineSinceMs >= thresholdMs;
  const alertDedupeKey = previous.alertDedupeKey
    || (thresholdReached ? `tailscale-device-offline:${input.deviceId}:${offlineSince}` : null);
  const smsSentAtMs = validIsoTime(previous.smsSentAt);
  const reminderDelayMs = Math.max(1, input.reminderDelayMinutes ?? 60) * 60_000;
  const shouldRemind = smsSentAtMs !== null
    && !previous.reminderSmsSentAt
    && input.now.getTime() - smsSentAtMs >= reminderDelayMs;

  return {
    state: {
      registered: true,
      boundDnsName,
      boundHostName,
      lastCheckedAt: nowIso,
      lastOnlineAt: previous.lastOnlineAt || null,
      offlineSince,
      consecutiveOffline: (previous.consecutiveOffline || 0) + 1,
      alertDedupeKey,
      alertHandledAt: previous.alertHandledAt || previous.smsSentAt || null,
      smsSentAt: previous.smsSentAt || null,
      reminderSmsSentAt: previous.reminderSmsSentAt || null,
      lastSmsError: previous.lastSmsError || null,
      lastRecoveredAt: previous.lastRecoveredAt || null,
    },
    shouldAlert: thresholdReached && !previous.alertHandledAt && !previous.smsSentAt,
    shouldRemind,
    recoveredAlertKey: null,
  };
}
