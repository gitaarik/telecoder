#!/usr/bin/env bash
set -euo pipefail

# Ensure NVM/node is on PATH when launched non-interactively (nohup, cron, etc.)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="${MODE:-dev}"
ACTION="${1:-status}"
if [[ "${ACTION}" == "dev" || "${ACTION}" == "prod" ]]; then
  MODE="${ACTION}"
  ACTION="${2:-status}"
fi

LOG_FILE="${ROOT_DIR}/claudegram.${MODE}.log"

# Match this checkout by its actual path rather than a hardcoded directory
# name, so renaming the folder doesn't silently break process detection.
# Metacharacters are escaped because pgrep -f treats the pattern as an ERE.
ROOT_DIR_RE="$(printf '%s' "${ROOT_DIR}" | sed 's/[].^$*+?(){}|[\\]/\\&/g')"

DEV_PATTERNS=(
  "tsx watch src/index.ts"
  "node .*${ROOT_DIR_RE}/node_modules/\.bin/tsx"
  "tsx/dist/loader"
  "npm run dev"
  "npm exec tsx watch src/index.ts"
  # Multi-instance launcher (npm run dev:multi)
  "tsx src/launcher.ts"
  "npm run dev:multi"
)

PROD_PATTERNS=(
  "node .*dist/index.js"
  "npm start"
  # Multi-instance launcher (npm run start:multi) — without these, botctl
  # reports "not running" while the launcher-based bot is very much running.
  "node .*dist/launcher\.js"
  "npm run start:multi"
)

ALL_PATTERNS=(
  "${DEV_PATTERNS[@]}"
  "${PROD_PATTERNS[@]}"
)

# The patterns above are generic — "npm run dev" or "tsx/dist/loader" match
# any project on the machine, and these pids get killed. Restrict matches to
# processes actually running out of this checkout.
#
# Needs /proc, so on systems without it (macOS) verification is skipped and
# the old, broader behaviour applies.
HAVE_PROC=0
[[ -d /proc/self ]] && HAVE_PROC=1

function pid_in_checkout() {
  local pid="$1" cwd
  [[ "${HAVE_PROC}" -eq 1 ]] || return 0
  # Unreadable cwd means the process belongs to another user, so not ours.
  cwd="$(readlink -e "/proc/${pid}/cwd" 2>/dev/null || true)"
  [[ -n "${cwd}" ]] || return 1
  [[ "${cwd}" == "${ROOT_DIR}" || "${cwd}" == "${ROOT_DIR}/"* ]]
}

function list_pids_for_patterns() {
  local -a patterns=("$@")
  local pids=()
  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] || continue
      pid_in_checkout "${pid}" || continue
      pids+=("${pid}")
    done < <(pgrep -f "${pattern}" || true)
  done

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 1
  fi

  printf "%s\n" "${pids[@]}" | sort -u
}

function list_pids() {
  local -a patterns
  if [[ "${MODE}" == "prod" ]]; then
    patterns=("${PROD_PATTERNS[@]}")
  else
    patterns=("${DEV_PATTERNS[@]}")
  fi
  list_pids_for_patterns "${patterns[@]}"
}

function list_pids_all() {
  list_pids_for_patterns "${ALL_PATTERNS[@]}"
}

function status() {
  if pids=$(list_pids 2>/dev/null); then
    echo "TeleCoder (${MODE}) is running:"
    echo "${pids}" | sed 's/^/  PID: /'
    return 0
  fi

  echo "TeleCoder (${MODE}) is not running."
  return 1
}

function wait_for_stop() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if ! list_pids >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function wait_for_stop_all() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if ! list_pids_all >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function wait_for_start() {
  local timeout="${1:-10}"
  local end=$((SECONDS + timeout))
  while (( SECONDS < end )); do
    if list_pids >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

function stop() {
  if ! pids=$(list_pids 2>/dev/null); then
    echo "No TeleCoder (${MODE}) process found."
    return 0
  fi

  echo "Stopping TeleCoder (${MODE})..."
  echo "${pids}" | xargs -r kill -TERM
  sleep 1

  if pids_after=$(list_pids 2>/dev/null); then
    echo "Force killing remaining PIDs:"
    echo "${pids_after}" | sed 's/^/  PID: /'
    echo "${pids_after}" | xargs -r kill -KILL
  fi

  if ! wait_for_stop 10; then
    echo "Warning: TeleCoder (${MODE}) did not fully stop within timeout."
  fi
}

function stop_all() {
  if ! pids=$(list_pids_all 2>/dev/null); then
    echo "No TeleCoder processes found."
    return 0
  fi

  echo "Stopping all TeleCoder processes..."
  echo "${pids}" | xargs -r kill -TERM
  sleep 1

  if pids_after=$(list_pids_all 2>/dev/null); then
    echo "Force killing remaining PIDs:"
    echo "${pids_after}" | sed 's/^/  PID: /'
    echo "${pids_after}" | xargs -r kill -KILL
  fi

  if ! wait_for_stop_all 10; then
    echo "Warning: TeleCoder processes did not fully stop within timeout."
  fi

  # Give OS time to release file descriptors after process death
  sleep 1
}

function start() {
  if status >/dev/null 2>&1; then
    echo "TeleCoder (${MODE}) already running."
    status
    return 0
  fi

  echo "Starting TeleCoder (${MODE})..."
  cd "${ROOT_DIR}"
  # Truncate log so nohup opens a clean file descriptor
  : > "${LOG_FILE}"
  if [[ "${MODE}" == "prod" ]]; then
    nohup npm start >> "${LOG_FILE}" 2>&1 &
  else
    nohup npm run dev >> "${LOG_FILE}" 2>&1 &
  fi

  if ! wait_for_start 10; then
    echo "Warning: TeleCoder (${MODE}) did not appear to start."
  fi
  status || true
  echo "Log: ${LOG_FILE}"
}

function recover() {
  stop_all
  start
}

case "${ACTION}" in
  status)
    status
    ;;
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop_all
    start
    ;;
  recover)
    recover
    ;;
  stop-all)
    stop_all
    ;;
  log)
    tail -n 50 "${LOG_FILE}"
    ;;
  *)
    echo "Usage: $(basename "$0") [dev|prod] {status|start|stop|stop-all|restart|recover|log}"
    exit 1
    ;;
esac
