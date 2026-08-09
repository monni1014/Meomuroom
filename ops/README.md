# Memoroom server operation

## Runtime layout

- `memoroom-app.service` runs the Next.js app and the email/RPA worker in one process.
- Naver-origin jobs write the matching external reservation to SpaceCloud.
- SpaceCloud-origin jobs close the matching Naver slots.
- The two platform queues run concurrently; writes targeting the same platform remain serialized by a process lock.
- Adjacent Naver payments for the same normalized name, phone, room, and KST date remain separate DB reservations but are represented by one grouped SpaceCloud block. A partial cancellation resizes that block in place; the final cancellation deletes it.
- Naver uses headless Chromium. SpaceCloud uses headed Chromium inside temporary Xvfb because headless writes are rejected.
- Headless Naver jobs reuse one server-side Chromium host to reduce startup time and memory churn. SpaceCloud write jobs and public competitor scans use isolated transient browsers and close them after each job.
- There is no separate `memoroom-rpa.service` or `memoroom-rpa.timer`. They are unmasked and intentionally not installed because `memoroom-app.service` already owns the single RPA worker; adding a second worker would duplicate bookings.
- `memoroom-app.service` uses cgroup lifecycle tracking. A controlled stop terminates the Next.js process, the shared browser host, and every Chromium child before the unit is considered stopped. Stale browser endpoint/start-lock files are cleared before each start.
- A planned stop/restart first waits until reservation RPA, retry queues, customer SMS submission, and competitor scanning are idle. If the app is unresponsive, the wait is bypassed so the health recovery restart is not blocked. Persisted mail jobs and time-based competitor catch-up recover work after an unexpected crash or forced timeout.
- The app service restarts after both failures and unexpected clean exits. An explicit `systemctl stop memoroom-app.service` still remains stopped, as expected for systemd.

## Manual-block reconciliation

`memoroom-spacecloud-reconcile.timer` runs at 03:00 Asia/Seoul every day. It checks future confirmed Naver reservations against SpaceCloud, fills one exact unlabelled manual block, and creates the external block when the period is genuinely open. It never overwrites an identified or ambiguous overlapping block.

Useful checks:

```sh
systemctl status memoroom-app.service
systemctl status memoroom-spacecloud-reconcile.timer
journalctl -u memoroom-spacecloud-reconcile.service -n 100 --no-pager
cd /srv/memoroom/app
node scripts/reconcile-spacecloud-manual-blocks.mjs --plan --full
```

There is no scheduled server reboot.

## Operator safe recovery

Settings > Cloud computer exposes a `Safe recovery` button for an operator-initiated app restart.
The web process cannot run privileged commands. It writes one UUID request to
`/srv/memoroom/shared/manual-recovery.request`, and
`memoroom-manual-recovery.path` starts the root-owned recovery service.
The service checks the RPA-idle endpoint again, restarts only
`memoroom-app.service`, verifies the app and SQLite health endpoint, and writes
the result to `/srv/memoroom/shared/manual-recovery-result.json`.
Naver and SpaceCloud browser services and the Linux server remain running.

Useful checks:

```sh
systemctl status memoroom-manual-recovery.path
systemctl status memoroom-manual-recovery.service
journalctl -u memoroom-manual-recovery.service -n 50 --no-pager
```

## Automatic memory cleanup

`memoroom-memory-auto-monitor.timer` checks Linux memory once per minute. When
used RAM remains at or above 75% for 10 continuous minutes, it waits until the
reservation, message, and competitor RPA queues are idle and writes a request
for the existing safe memory optimization service. The optimizer restarts the
Naver and SpaceCloud browser hosts sequentially, then verifies the app, SQLite,
and both login sessions. A six-hour cooldown prevents restart loops. Falling
below 75% resets the continuous-high-memory timer; an RPA-busy result is retried
on a later monitor pass without interrupting the live job.

The Settings > Cloud computer manual cleanup button remains available as an
operator fallback from 60% used RAM.

Useful checks:

```sh
systemctl status memoroom-memory-auto-monitor.timer
systemctl status memoroom-memory-auto-monitor.service
cat /srv/memoroom/shared/memory-optimization-auto-state.json
journalctl -u memoroom-memory-auto-monitor.service -n 50 --no-pager
```

## Freeze recovery

`memoroom-healthcheck.timer` calls the local `/api/health` endpoint every minute.
The endpoint verifies both the Next.js event loop and a read-only SQLite query.
Three consecutive failures trigger one controlled restart of
`memoroom-app.service`. A 10-minute cooldown prevents restart loops, and an app
that still fails after restart is left running for diagnosis instead of
rebooting the whole server.

Before a controlled app restart, `memoroom-ops-alert.mjs` records a dashboard
alert and sends Web Push plus the optional Solapi operator SMS. It sends a
second recovery notice after the health endpoint succeeds. The boot alert
service sends the same out-of-band notice after any full server reboot. A
sudden hard freeze cannot execute a pre-reboot hook on the frozen VM itself, so
that case is reported immediately after boot; a true pre-reboot warning for a
hard freeze requires a monitor running outside this server.

The Vultr VM exposes an Intel 6300ESB hardware watchdog. systemd feeds it with a
three-minute runtime timeout. If the Linux kernel or system manager actually
freezes and can no longer feed the device, the VM reboots automatically. A
temporary internet, proxy, or Tailscale outage does not affect this local
watchdog. `/etc/modules-load.d/memoroom-watchdog.conf` loads the `i6300esb`
driver, and `/etc/systemd/system.conf.d/50-memoroom-watchdog.conf` contains the
systemd manager settings. The driver is also included in the initramfs so the
device exists before PID 1 starts. The unused legacy `watchdog.service` and
`wd_keepalive.service` are masked; systemd PID 1 is the only process allowed to
own `/dev/watchdog0`.

Useful checks:

```sh
curl --fail http://127.0.0.1:3000/api/health
systemctl status memoroom-healthcheck.timer
journalctl -u memoroom-boot-alert.service -n 50 --no-pager
journalctl -t memoroom-healthcheck -n 50 --no-pager
systemctl show -p RuntimeWatchdogUSec -p RebootWatchdogUSec
```

## RPA UI contract monitoring

The app performs read-only Naver and SpaceCloud UI checks at 02:20, 08:20,
14:20, and 20:20 Asia/Seoul. Naver opens tomorrow's slot panel and inspects the
toggle states and save control without clicking either. SpaceCloud opens and
closes the external-reservation modal without clicking its final confirmation.
If another RPA process owns the platform lock, the check is skipped instead of
competing with the live reservation job.

Critical controls use staged self-healing. A changed label or selector is first
treated as a candidate. Only the same unique candidate that passes two separate
read-only checks is promoted for live use. Ambiguous candidates never promote,
and live mutations still require the existing fresh-page result verification.
Promotion state is stored in the git-ignored
`rpa/.runtime/self-healing-controls/` directory.
Manual server-side health runs must use the `memoroom` service account (for
example, `runuser -u memoroom -- ...`) so these runtime files never become
root-owned. A live reservation must continue to its fresh-page verification if
only this auxiliary state write fails.

Every live reservation RPA also reports failures through the same classifier:

- missing selectors, labels, or expected layout: `RPA_UI_CHANGE`
- expired login or 401/403: `RPA_LOGIN_SESSION`
- proxy/DNS/connection failures: `RPA_NETWORK`
- other automation failures: `RPA_FAILURE`

Alerts are deduplicated per platform and screen, appear on the Memoroom
dashboard, and use `ADMIN_ALERT_WEBHOOK_URL` when that optional webhook is
configured. Failure screenshots are stored under `rpa/screenshots`; a later
successful check of the same screen resolves its alert.

## Windows Tailscale watchdog

`ops/windows/Install-MemoroomTailscaleWatchdog.ps1` installs two least-privilege
tasks. Every five minutes the signed-in operator task checks the actual private
route to the Memoroom server. A `NoState` client cannot reach that route, so only
when the route is unavailable does it leave a recovery request. A separate SYSTEM task consumes that request and
restarts only the Tailscale service, with a 10-minute recovery cooldown. It does
not restart the laptop, server, app, or RPA worker.

### Pending mobile connectivity checks

The following items were explicitly deferred on 2026-07-23 and require real
device verification before they can be marked complete:

- Distinguish Tailscale devices as iPhone, Galaxy, laptop, and desktop. The
  wife's iPhone must be changed from temporary/shared access to its own invited,
  regular Tailscale user and device identity. Verify that the Memoroom private
  URL still opens after the transition.
- Add a server-side offline monitor that sends a Solapi fallback SMS containing
  the affected device name after repeated offline observations. The polling
  interval and offline grace period still need to be chosen so normal phone
  sleep or network handoffs do not trigger false alarms.
- Keep this server-side device warning separate from the Windows `NoState`
  watchdog above, which only repairs the local Windows Tailscale service.
- Galaxy Web Push arrives, but vibration was not felt even with the phone in
  vibration mode and Memoroom notifications enabled. The service worker already
  uses `silent: false` and `vibrate: [300, 150, 300]`; next checks are the old
  service-worker/browser notification channel, Samsung category vibration, and
  battery-optimization exemptions.
- iPhone Web Push vibration is controlled by iOS notification and system haptic
  settings; a web app cannot require a custom vibration pattern.
- The current high-resolution monochrome Memoroom notification badge is the
  approved final icon. Do not resize it again while investigating vibration.

### Pending Google Calendar integration

- Use the wife's Google account, which is the account used on her iPhone.
- Request the Google Calendar OAuth scope separately; the existing Google
  People contact scope does not grant calendar access.
- Keep the Memoroom SQLite reservation as the source of truth and mirror only
  confirmed reservations into a dedicated Memoroom calendar.
- Create, update, and delete/cancel the corresponding calendar event whenever
  the Memoroom reservation changes. Use a stable reservation-derived event ID
  so retries cannot create duplicates.
- Suggested visible event title: `머무룸2 · 구은영`; use the actual reservation
  start/end as event times. Keep the phone number and private notes out of the
  lock-screen title and store them only in event details if needed.
- After syncing, add the calendar's upcoming-event widget to the Galaxy and
  iPhone lock screens. Memoroom app push can additionally send an owner reminder
  before the reservation; the lead time is not final yet.
- Verify create, time/room/name edit, cancellation, duplicate retry, and cross-
  device display before enabling automatic sync for all live reservations.

## Database backup

`memoroom-db-backup.timer` creates an online SQLite backup four times per day
at 00:30, 06:30, 12:30, and 18:30 Asia/Seoul time. The backup script validates
SQLite integrity, uploads through the encrypted `memoroom-crypt` rclone
remote, downloads the uploaded file, and verifies its SHA-256 hash.

- Local retention: 7 days
- Encrypted Google Drive retention: 30 days
- Script install path: `/usr/local/sbin/memoroom-db-backup`
- Local backup path: `/var/backups/memoroom`
- rclone config path: `/root/.config/rclone/rclone.conf`
