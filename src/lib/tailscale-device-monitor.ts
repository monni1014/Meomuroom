import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import { prisma } from "@/lib/prisma";
import { sendOperationalAlertSms } from "@/lib/solapi-sms";
import {
  evaluateTailscaleDeviceObservation,
  type TailscaleDeviceMonitorState,
} from "@/lib/tailscale-device-monitor-policy";

const execFile = promisify(execFileCallback);
const CONFIG_KEY = "tailscale.deviceMonitor.config";
const STATE_KEY = "tailscale.deviceMonitor.state";

type DeviceMatch = {
  dnsName?: string;
  hostName?: string;
  os?: string;
  loginName?: string;
};

type DeviceTarget = {
  id: string;
  label: string;
  recipientPhone: string;
  enabled?: boolean;
  offlineThresholdMinutes?: number;
  match?: DeviceMatch;
  autoDiscover?: DeviceMatch & { excludeDnsNames?: string[]; excludeHostNames?: string[] };
};

type DeviceMonitorConfig = {
  enabled: boolean;
  intervalMinutes: number;
  offlineThresholdMinutes: number;
  reminderDelayMinutes?: number;
  devices: DeviceTarget[];
};

type TailscalePeer = {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  UserID?: number;
  Online?: boolean;
};

type TailscaleStatus = {
  BackendState?: string;
  Peer?: Record<string, TailscalePeer>;
  User?: Record<string, { LoginName?: string }>;
};

type FlattenedPeer = {
  id: string;
  hostName: string;
  dnsName: string;
  os: string;
  loginName: string;
  online: boolean;
};

type StoredState = Record<string, TailscaleDeviceMonitorState>;

function normalized(value: string | null | undefined) {
  return (value || "").trim().toLocaleLowerCase("en-US");
}

function matches(peer: FlattenedPeer, match: DeviceMatch) {
  if (match.dnsName && normalized(peer.dnsName) !== normalized(match.dnsName)) return false;
  if (match.hostName && normalized(peer.hostName) !== normalized(match.hostName)) return false;
  if (match.os && normalized(peer.os) !== normalized(match.os)) return false;
  if (match.loginName && normalized(peer.loginName) !== normalized(match.loginName)) return false;
  return true;
}

function flattenPeers(status: TailscaleStatus) {
  const users = status.User || {};
  return Object.values(status.Peer || {})
    .filter((peer) => peer.ID && peer.OS)
    .map((peer): FlattenedPeer => ({
      id: peer.ID || "",
      hostName: peer.HostName || "",
      dnsName: peer.DNSName || "",
      os: peer.OS || "",
      loginName: users[String(peer.UserID || "")]?.LoginName || "",
      online: peer.Online === true,
    }));
}

function findTargetPeer(target: DeviceTarget, previous: TailscaleDeviceMonitorState | undefined, peers: FlattenedPeer[]) {
  if (previous?.boundDnsName) {
    const bound = peers.find((peer) => normalized(peer.dnsName) === normalized(previous.boundDnsName));
    if (bound) return bound;
  }

  if (target.match) {
    return peers.find((peer) => matches(peer, target.match || {})) || null;
  }

  if (!target.autoDiscover) return null;
  const excludedDns = new Set((target.autoDiscover.excludeDnsNames || []).map(normalized));
  const excludedHosts = new Set((target.autoDiscover.excludeHostNames || []).map(normalized));
  const candidates = peers.filter((peer) => (
    matches(peer, target.autoDiscover || {})
    && !excludedDns.has(normalized(peer.dnsName))
    && !excludedHosts.has(normalized(peer.hostName))
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

async function readJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const setting = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (!setting) return fallback;
  try {
    return JSON.parse(setting.value) as T;
  } catch {
    return fallback;
  }
}

async function writeState(state: StoredState) {
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, value },
    update: { value },
  });
}

async function readTailscaleStatus() {
  const { stdout } = await execFile("/usr/bin/tailscale", ["status", "--json"], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as TailscaleStatus;
}

function buildOfflineMessage(thresholdMinutes: number) {
  const duration = thresholdMinutes % 60 === 0
    ? `${thresholdMinutes / 60}시간`
    : `${thresholdMinutes}분`;
  return `[머무룸] Tailscale이 ${duration}째 꺼져 있습니다. 앱을 열어 연결을 켜주세요.`;
}

function buildReminderMessage() {
  return "[머무룸 재알림] Tailscale이 계속 꺼져 있습니다. 앱을 열어 연결을 켜주세요.";
}

export async function checkTailscaleDevicesAndAlert(now = new Date()) {
  const config = await readJsonSetting<DeviceMonitorConfig | null>(CONFIG_KEY, null);
  if (!config?.enabled) return { skipped: true, reason: "not-configured", results: [] };

  const status = await readTailscaleStatus();
  if (status.BackendState !== "Running") {
    throw new Error(`Tailscale backend is ${status.BackendState || "unknown"}.`);
  }

  const peers = flattenPeers(status);
  const state = await readJsonSetting<StoredState>(STATE_KEY, {});
  const results: Array<{ id: string; label: string; status: string; smsSent: boolean; reminderSmsSent: boolean }> = [];

  for (const target of config.devices.filter((device) => device.enabled !== false)) {
    const previous = state[target.id];
    const peer = findTargetPeer(target, previous, peers);
    const explicitlyRegistered = Boolean(target.match);
    const offlineThresholdMinutes = target.offlineThresholdMinutes ?? config.offlineThresholdMinutes;
    const decision = evaluateTailscaleDeviceObservation({
      deviceId: target.id,
      now,
      offlineThresholdMinutes,
      reminderDelayMinutes: config.reminderDelayMinutes ?? 60,
      previous,
      observation: {
        registered: explicitlyRegistered || Boolean(peer) || previous?.registered === true,
        online: peer?.online === true,
        dnsName: peer?.dnsName || null,
        hostName: peer?.hostName || null,
      },
    });
    state[target.id] = decision.state;

    if (decision.recoveredAlertKey) {
      await resolveAdminAlertByDedupeKey(decision.recoveredAlertKey);
    }

    let smsSent = false;
    let reminderSmsSent = false;
    if (decision.shouldAlert && decision.state.alertDedupeKey) {
      await createAdminAlert({
        type: "TAILSCALE_DEVICE_OFFLINE",
        severity: "CRITICAL",
        title: `Tailscale 연결 끊김 · ${target.label}`,
        message: `${target.label}의 Tailscale 연결이 ${offlineThresholdMinutes}분 이상 끊어졌습니다. 앱을 열어 연결을 켜주세요.`,
        dedupeKey: decision.state.alertDedupeKey,
      });

      const sms = await sendOperationalAlertSms({
        to: target.recipientPhone,
        text: buildOfflineMessage(offlineThresholdMinutes),
      });
      if (sms.success && !sms.dryRun) {
        state[target.id] = {
          ...state[target.id],
          smsSentAt: now.toISOString(),
          lastSmsError: null,
        };
        smsSent = true;
      } else {
        state[target.id] = {
          ...state[target.id],
          lastSmsError: sms.dryRun ? "Solapi real send is disabled for this recipient." : sms.error || "Unknown Solapi error",
        };
      }
    }

    if (decision.shouldRemind) {
      const reminderSms = await sendOperationalAlertSms({
        to: target.recipientPhone,
        text: buildReminderMessage(),
      });
      if (reminderSms.success && !reminderSms.dryRun) {
        state[target.id] = {
          ...state[target.id],
          reminderSmsSentAt: now.toISOString(),
          lastSmsError: null,
        };
        reminderSmsSent = true;
      } else {
        state[target.id] = {
          ...state[target.id],
          lastSmsError: reminderSms.dryRun
            ? "Solapi real send is disabled for this recipient."
            : reminderSms.error || "Unknown Solapi reminder error",
        };
      }
    }

    results.push({
      id: target.id,
      label: target.label,
      status: !state[target.id].registered ? "UNREGISTERED" : peer?.online ? "ONLINE" : "OFFLINE",
      smsSent,
      reminderSmsSent,
    });
  }

  await writeState(state);
  return { skipped: false, results };
}
