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
