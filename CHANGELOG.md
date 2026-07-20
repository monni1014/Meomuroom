# Changelog

All notable changes to Memoroom are documented in this file. Versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] - 2026-07-20

### Added

- Server-only RPA execution controls and persistent job queue handling.
- Naver and SpaceCloud reservation reconciliation for automated and manual slot blocks.
- Competitor monitoring schedules, evidence capture, and proxy-backed status checks.
- Proxy status, expiry, payment-history, and cost management in Settings.
- systemd service and reconciliation timer templates for production operations.
- Encrypted, verified Google Drive backups for the production SQLite database.
- Login-session validation and SpaceCloud diagnostic tooling.
- Customer SMS inbox that joins Solapi outbound records with Android phone replies.
- Privacy-filtered Android SMS bridge with reservation-phone matching, deduplication,
  unread indicators, and per-device connection status.

### Fixed

- Dashboard, calendar, usage, monthly-table, proxy-payment, and server runtime
  date boundaries now consistently use Asia/Seoul time.
- Explicit Korea Standard Time parsing for Naver and SpaceCloud reservation emails.
- Naver cancellation matching and cleanup of detached pending cancellation jobs.
- RPA process locking, browser cleanup, and duplicate execution prevention.
- SQLite connection behavior for the production server runtime.

### Operations

- Prepared the application for single-server operation on Vultr.
- Added a two-stage Windows Tailscale watchdog that separates user-level
  private-route checks from administrator-only service recovery.
- Kept databases, browser sessions, credentials, logs, and production correction data out of Git.
