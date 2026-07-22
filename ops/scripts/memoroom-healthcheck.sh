#!/usr/bin/env bash
set -Eeuo pipefail

HEALTH_URL="${MEMOROOM_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
APP_SERVICE="${MEMOROOM_APP_SERVICE:-memoroom-app.service}"
STATE_DIR="${MEMOROOM_HEALTH_STATE_DIR:-/run/memoroom-healthcheck}"
MAX_FAILURES="${MEMOROOM_HEALTH_MAX_FAILURES:-3}"
RESTART_COOLDOWN_SECONDS="${MEMOROOM_HEALTH_RESTART_COOLDOWN_SECONDS:-600}"
OPS_ALERT_SCRIPT="${MEMOROOM_OPS_ALERT_SCRIPT:-/srv/memoroom/app/ops/scripts/memoroom-ops-alert.mjs}"
SERVER_METRICS_SCRIPT="${MEMOROOM_SERVER_METRICS_SCRIPT:-/srv/memoroom/app/ops/scripts/memoroom-record-server-metrics.mjs}"

FAILURE_FILE="$STATE_DIR/failures"
LAST_RESTART_FILE="$STATE_DIR/last-restart"

mkdir -p "$STATE_DIR"

log_message() {
  logger -t memoroom-healthcheck -- "$1"
  printf '%s\n' "$1"
}

send_ops_alert() {
  local alert_mode="$1"
  if [[ ! -f "$OPS_ALERT_SCRIPT" ]]; then
    log_message "Ops alert script is missing: $OPS_ALERT_SCRIPT"
    return 0
  fi
  timeout 25s runuser -u memoroom -- \
    env HOME=/srv/memoroom MEMOROOM_APP_ROOT=/srv/memoroom/app \
    /usr/bin/node "$OPS_ALERT_SCRIPT" "$alert_mode" || \
    log_message "Ops alert delivery failed for mode=$alert_mode; recovery will continue."
}

record_server_metrics() {
  if [[ -f "$SERVER_METRICS_SCRIPT" ]]; then
    timeout 15s /usr/bin/node "$SERVER_METRICS_SCRIPT" || true
  fi
}

record_server_metrics

check_health() {
  local response
  response="$(curl --silent --show-error --fail \
    --connect-timeout 3 \
    --max-time 10 \
    --header 'Cache-Control: no-cache' \
    "$HEALTH_URL" 2>/dev/null)" || return 1
  [[ "$response" == *'"ok":true'* ]]
}

if check_health; then
  rm -f -- "$FAILURE_FILE"
  exit 0
fi

if ! systemctl is-active --quiet "$APP_SERVICE"; then
  if systemctl is-failed --quiet "$APP_SERVICE"; then
    log_message "$APP_SERVICE is failed; resetting and starting it."
    send_ops_alert "app-restart"
    systemctl reset-failed "$APP_SERVICE"
    systemctl start "$APP_SERVICE"
  else
    log_message "$APP_SERVICE is intentionally inactive; health recovery skipped."
  fi
  exit 0
fi

failure_count=0
if [[ -f "$FAILURE_FILE" ]]; then
  read -r failure_count < "$FAILURE_FILE" || failure_count=0
fi
if ! [[ "$failure_count" =~ ^[0-9]+$ ]]; then
  failure_count=0
fi
failure_count=$((failure_count + 1))
printf '%s\n' "$failure_count" > "$FAILURE_FILE"

if (( failure_count < MAX_FAILURES )); then
  log_message "Health check failed ($failure_count/$MAX_FAILURES); waiting for another check before recovery."
  exit 0
fi

now_epoch="$(date +%s)"
last_restart_epoch=0
if [[ -f "$LAST_RESTART_FILE" ]]; then
  read -r last_restart_epoch < "$LAST_RESTART_FILE" || last_restart_epoch=0
fi
if ! [[ "$last_restart_epoch" =~ ^[0-9]+$ ]]; then
  last_restart_epoch=0
fi

if (( now_epoch - last_restart_epoch < RESTART_COOLDOWN_SECONDS )); then
  log_message "Health check is still failing, but app restart is in the cooldown window."
  exit 1
fi

printf '%s\n' "$now_epoch" > "$LAST_RESTART_FILE"
log_message "Health check failed $failure_count times; restarting $APP_SERVICE."
send_ops_alert "app-restart"
systemctl restart "$APP_SERVICE"

for _attempt in {1..15}; do
  sleep 3
  if check_health; then
    rm -f -- "$FAILURE_FILE"
    log_message "$APP_SERVICE recovered after a controlled restart."
    send_ops_alert "app-recovered"
    exit 0
  fi
done

log_message "$APP_SERVICE did not recover after restart; leaving the server running for diagnosis."
exit 1
