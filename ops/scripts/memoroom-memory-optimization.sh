#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${MEMOROOM_APP_DIR:-/srv/memoroom/app}"
REQUEST_PATH="${MEMOROOM_MEMORY_OPTIMIZATION_REQUEST_PATH:-/srv/memoroom/shared/memory-optimization.request}"
RESULT_PATH="${MEMOROOM_MEMORY_OPTIMIZATION_RESULT_PATH:-/srv/memoroom/shared/memory-optimization-result.json}"
MAINTENANCE_LOCK_PATH="${MEMOROOM_RPA_MAINTENANCE_LOCK_PATH:-/srv/memoroom/shared/rpa-maintenance.lock}"
READINESS_URL="${MEMOROOM_RPA_IDLE_URL:-http://127.0.0.1:3000/api/internal/rpa-idle}"
HEALTH_URL="${MEMOROOM_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
REQUEST_ID=""
RESULT_WRITTEN=0

memory_used_bytes() {
  awk '/MemTotal:/ { total=$2 } /MemAvailable:/ { available=$2 } END { printf "%.0f", (total-available)*1024 }' /proc/meminfo
}

write_result() {
  local status="$1"
  local message="$2"
  local before_bytes="${3:-}"
  local after_bytes="${4:-}"
  local reclaimed_bytes="${5:-}"
  local temp_path="${RESULT_PATH}.${REQUEST_ID}.tmp"

  /usr/bin/node - "$temp_path" "$REQUEST_ID" "$status" "$message" "$before_bytes" "$after_bytes" "$reclaimed_bytes" <<'NODE'
const fs = require("node:fs");
const [path, requestId, status, message, before, after, reclaimed] = process.argv.slice(2);
const payload = { requestId, status, message, updatedAt: new Date().toISOString() };
if (before !== "") payload.beforeUsedBytes = Number(before);
if (after !== "") payload.afterUsedBytes = Number(after);
if (reclaimed !== "") payload.reclaimedBytes = Number(reclaimed);
fs.writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
NODE
  /usr/bin/chown memoroom:memoroom "$temp_path"
  /usr/bin/mv -f "$temp_path" "$RESULT_PATH"
  RESULT_WRITTEN=1
}

cleanup() {
  /usr/bin/rm -f "$MAINTENANCE_LOCK_PATH"
  if [[ -n "$REQUEST_ID" && "$RESULT_WRITTEN" -eq 0 ]]; then
    write_result "FAILED" "RAM 정리 중 예기치 않은 오류가 발생했습니다." || true
  fi
}
trap cleanup EXIT

readiness_is_idle() {
  /usr/bin/curl --fail --silent --show-error --max-time 10 "$READINESS_URL" \
    | /usr/bin/node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.exit(JSON.parse(d).idle===true?0:1)}catch{process.exit(1)}})'
}

wait_for_browser() {
  local role="$1"
  local state_path="$APP_DIR/rpa/.runtime/browser-host-${role}.json"
  local endpoint=""
  local attempt

  for attempt in $(seq 1 45); do
    if /usr/bin/systemctl is-active --quiet "memoroom-rpa-browser@${role}.service" && [[ -s "$state_path" ]]; then
      endpoint="$(/usr/bin/node -e 'const fs=require("node:fs");try{process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).cdpEndpoint||"")}catch{}' "$state_path")"
      if [[ -n "$endpoint" ]] && /usr/bin/curl --fail --silent --max-time 2 "${endpoint}/json/version" >/dev/null; then
        return 0
      fi
    fi
    /usr/bin/sleep 1
  done
  return 1
}

if [[ ! -s "$REQUEST_PATH" ]]; then
  exit 0
fi

REQUEST_ID="$(tr -d '[:space:]' < "$REQUEST_PATH")"
/usr/bin/rm -f "$REQUEST_PATH"
if [[ -z "$REQUEST_ID" ]]; then
  exit 0
fi

write_result "RUNNING" "예약 작업이 없는지 확인하고 있습니다."
RESULT_WRITTEN=0

if ! readiness_is_idle; then
  write_result "CANCELLED" "예약·문자·점검 작업 중이라 RAM 정리를 취소했습니다."
  exit 0
fi

printf '%s\n' "$REQUEST_ID" > "${MAINTENANCE_LOCK_PATH}.${REQUEST_ID}.tmp"
/usr/bin/chown memoroom:memoroom "${MAINTENANCE_LOCK_PATH}.${REQUEST_ID}.tmp"
/usr/bin/chmod 0644 "${MAINTENANCE_LOCK_PATH}.${REQUEST_ID}.tmp"
/usr/bin/mv -f "${MAINTENANCE_LOCK_PATH}.${REQUEST_ID}.tmp" "$MAINTENANCE_LOCK_PATH"

if ! readiness_is_idle; then
  write_result "CANCELLED" "RAM 정리 직전에 새 작업이 시작되어 안전하게 취소했습니다."
  exit 0
fi

before_used="$(memory_used_bytes)"
write_result "RUNNING" "네이버·스클 브라우저 메모리를 순서대로 정리하고 있습니다." "$before_used"
RESULT_WRITTEN=0

for role in naver spacecloud; do
  /usr/bin/systemctl restart "memoroom-rpa-browser@${role}.service"
  if ! wait_for_browser "$role"; then
    write_result "FAILED" "${role} 브라우저를 다시 확인하지 못해 정리를 중단했습니다." "$before_used"
    exit 0
  fi
done

if ! /usr/bin/curl --fail --silent --show-error --max-time 10 "$HEALTH_URL" \
  | /usr/bin/node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.exit(JSON.parse(d).ok===true?0:1)}catch{process.exit(1)}})'; then
  write_result "FAILED" "브라우저 정리 후 앱·DB 상태 확인에 실패했습니다." "$before_used"
  exit 0
fi

if ! /usr/bin/timeout 150s /usr/sbin/runuser -u memoroom -- /usr/bin/node "$APP_DIR/scripts/validate-login-sessions.mjs" >/tmp/memoroom-memory-session-check.log 2>&1; then
  write_result "FAILED" "브라우저 정리 후 로그인 세션 확인에 실패했습니다. 재로그인이 필요할 수 있습니다." "$before_used"
  exit 0
fi

/usr/bin/sleep 3
after_used="$(memory_used_bytes)"
reclaimed=$(( before_used > after_used ? before_used - after_used : 0 ))
write_result "COMPLETED" "RAM 안전 정리를 완료했고 앱·DB·로그인 세션까지 확인했습니다." "$before_used" "$after_used" "$reclaimed"
