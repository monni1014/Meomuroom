#!/usr/bin/env bash
set -Eeuo pipefail

REQUEST_PATH="${MEMOROOM_MANUAL_RECOVERY_REQUEST_PATH:-/srv/memoroom/shared/manual-recovery.request}"
RESULT_PATH="${MEMOROOM_MANUAL_RECOVERY_RESULT_PATH:-/srv/memoroom/shared/manual-recovery-result.json}"
READINESS_URL="${MEMOROOM_RPA_IDLE_URL:-http://127.0.0.1:3000/api/internal/rpa-idle}"
HEALTH_URL="${MEMOROOM_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
APP_SERVICE="${MEMOROOM_APP_SERVICE:-memoroom-app.service}"

log_message() {
  logger -t memoroom-manual-recovery -- "$1"
  printf '%s\n' "$1"
}

write_result() {
  local status="$1"
  local message="$2"
  local updated_at temporary_path
  updated_at="$(date --iso-8601=seconds)"
  temporary_path="$(mktemp "${RESULT_PATH}.tmp.XXXXXX")"
  printf '{"requestId":"%s","status":"%s","message":"%s","updatedAt":"%s"}\n' \
    "$request_id" "$status" "$message" "$updated_at" > "$temporary_path"
  chmod 0644 "$temporary_path"
  chown memoroom:memoroom "$temporary_path"
  mv -f -- "$temporary_path" "$RESULT_PATH"
}

if [[ ! -f "$REQUEST_PATH" ]]; then
  log_message "Recovery request file is missing; nothing to do."
  exit 0
fi

IFS= read -r request_id < "$REQUEST_PATH" || request_id=""
rm -f -- "$REQUEST_PATH"

if [[ ! "$request_id" =~ ^[0-9a-f-]{36}$ ]]; then
  log_message "Recovery request id is invalid."
  exit 2
fi

write_result "RUNNING" "안전 복구 준비 중"

readiness="$(curl --silent --show-error --fail --connect-timeout 3 --max-time 10 "$READINESS_URL")" || {
  write_result "CANCELLED" "자동화 작업 상태를 확인하지 못해 안전 복구를 취소했습니다."
  log_message "Readiness endpoint is unavailable; recovery cancelled."
  exit 0
}

if [[ "$readiness" != *'"idle":true'* ]]; then
  write_result "CANCELLED" "새 자동화 작업이 시작되어 안전 복구를 취소했습니다."
  log_message "Active automation appeared after the request; recovery cancelled."
  exit 0
fi

# Give the web response enough time to reach the operator before the app stops.
sleep 3
log_message "Restarting $APP_SERVICE after idle checks passed."
if ! systemctl restart "$APP_SERVICE"; then
  write_result "FAILED" "머무룸 앱을 재시작하지 못했습니다."
  log_message "$APP_SERVICE restart command failed."
  exit 1
fi

for _attempt in {1..30}; do
  sleep 2
  response="$(curl --silent --show-error --fail --connect-timeout 3 --max-time 10 "$HEALTH_URL" 2>/dev/null)" || continue
  if [[ "$response" == *'"ok":true'* ]]; then
    write_result "COMPLETED" "머무룸 앱과 데이터베이스가 정상적으로 복구됐습니다."
    log_message "$APP_SERVICE recovered successfully."
    exit 0
  fi
done

write_result "FAILED" "재시작 후 앱 정상 응답을 확인하지 못했습니다."
log_message "$APP_SERVICE did not recover within the verification window."
exit 1
