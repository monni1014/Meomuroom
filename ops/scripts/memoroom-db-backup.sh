#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

DB_PATH="${MEMOROOM_DB_PATH:-/srv/memoroom/app/dev.db}"
BACKUP_ROOT="${MEMOROOM_BACKUP_DIR:-/var/backups/memoroom}"
RCLONE_REMOTE="${MEMOROOM_BACKUP_REMOTE:-memoroom-crypt:database}"
LOCAL_RETENTION_DAYS="${MEMOROOM_LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${MEMOROOM_REMOTE_RETENTION_DAYS:-30}"
LOCK_PATH="${MEMOROOM_BACKUP_LOCK:-/run/lock/memoroom-db-backup.lock}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

for command_name in sqlite3 gzip sha256sum rclone flock; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_ROOT" "$(dirname "$LOCK_PATH")"

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "Another Memoroom database backup is already running; skipping."
  exit 0
fi

work_dir="$(mktemp -d "$BACKUP_ROOT/.tmp.XXXXXX")"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

timestamp="$(TZ=Asia/Seoul date +'%Y%m%d-%H%M%S-KST')"
base_name="memoroom-db-$timestamp.sqlite3"
snapshot_path="$work_dir/$base_name"
archive_name="$base_name.gz"
archive_path="$BACKUP_ROOT/$archive_name"
checksum_name="$archive_name.sha256"
checksum_path="$BACKUP_ROOT/$checksum_name"

printf '.timeout 30000\n.backup %s\n' "$snapshot_path" | sqlite3 "$DB_PATH"

quick_check="$(sqlite3 "$snapshot_path" 'PRAGMA quick_check;')"
if [[ "$quick_check" != "ok" ]]; then
  echo "SQLite quick_check failed for generated backup: $quick_check" >&2
  exit 1
fi

gzip -9 "$snapshot_path"
mv -- "$snapshot_path.gz" "$archive_path"
(
  cd "$BACKUP_ROOT"
  sha256sum "$archive_name" >"$checksum_name"
)

rclone copyto "$archive_path" "$RCLONE_REMOTE/$archive_name" --retries 5 --low-level-retries 10
rclone copyto "$checksum_path" "$RCLONE_REMOTE/$checksum_name" --retries 5 --low-level-retries 10

verify_path="$work_dir/$archive_name"
rclone copyto "$RCLONE_REMOTE/$archive_name" "$verify_path" --retries 5 --low-level-retries 10
expected_hash="$(cut -d ' ' -f 1 "$checksum_path")"
actual_hash="$(sha256sum "$verify_path" | cut -d ' ' -f 1)"
if [[ "$actual_hash" != "$expected_hash" ]]; then
  echo "Google Drive verification hash mismatch for $archive_name" >&2
  exit 1
fi

find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'memoroom-db-*.sqlite3.gz' -mtime "+$LOCAL_RETENTION_DAYS" -delete
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'memoroom-db-*.sqlite3.gz.sha256' -mtime "+$LOCAL_RETENTION_DAYS" -delete

rclone delete "$RCLONE_REMOTE" \
  --min-age "${REMOTE_RETENTION_DAYS}d" \
  --include 'memoroom-db-*.sqlite3.gz' \
  --include 'memoroom-db-*.sqlite3.gz.sha256' \
  --rmdirs

echo "Backup completed and verified: $archive_name sha256=$expected_hash"
