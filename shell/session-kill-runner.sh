#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

local_edge_session_kill_required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "[local-edge] ERROR: ${name} is required for session kill runner." >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

PROJECT_ROOT="$(local_edge_session_kill_required_env LOCAL_EDGE_SESSION_KILL_PROJECT_ROOT)"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
RUN_STATE_DIR="${LOCAL_EDGE_SESSION_KILL_RUN_STATE_DIR:-${PROJECT_ROOT}/.tmp/local-edge/run}"
RUNTIME_STOP_LIB="${LOCAL_EDGE_SESSION_KILL_RUNTIME_STOP_LIB:-${PACKAGE_SHELL_DIR}/runtime-stop-lib.sh}"
RUN_SHELL_PID_FILE="${RUN_STATE_DIR}/local-session-shell.pid"
RUN_CHILD_PID_FILE="${RUN_STATE_DIR}/local-session-child.pid"
RUN_CHILD_PGID_FILE="${RUN_STATE_DIR}/local-session-child.pgid"
RUN_HEALTHCHECK_PID_FILE="${RUN_STATE_DIR}/local-session-healthcheck.pid"
RUN_ENV_WATCHER_PID_FILE="${RUN_STATE_DIR}/local-session-env-watch.pid"
RUN_HEARTBEAT_PID_FILE="${RUN_STATE_DIR}/local-session-heartbeat.pid"
LOG_PREFIX="${LOCAL_EDGE_SESSION_KILL_LOG_PREFIX:-[local-edge:session-kill]}"
LOCAL_KILL_WAIT_ATTEMPTS="${LOCAL_EDGE_SESSION_KILL_WAIT_ATTEMPTS:-40}"

if [[ ! -f "${RUNTIME_STOP_LIB}" ]]; then
  echo "${LOG_PREFIX} ERROR: runtime stop shell library not found: ${RUNTIME_STOP_LIB}" >&2
  exit 2
fi
# shellcheck source=./runtime-stop-lib.sh
source "${RUNTIME_STOP_LIB}"

case "${LOCAL_KILL_WAIT_ATTEMPTS}" in
  ''|*[!0-9]*)
    LOCAL_KILL_WAIT_ATTEMPTS="40"
    ;;
esac

declare -a LOCAL_KILL_WAIT_PIDS=()
LOCAL_KILL_WAIT_PID_COUNT=0

track_wait_pid() {
  local raw_pid="${1:-}"
  local pid=""

  pid="$(printf "%s" "${raw_pid}" | tr -d '[:space:]')"
  if [[ -z "${pid}" || "${pid}" == "$$" ]]; then
    return 0
  fi
  if [[ "${LOCAL_KILL_WAIT_PID_COUNT}" -gt 0 ]] && runtime_stop_array_contains "${pid}" "${LOCAL_KILL_WAIT_PIDS[@]}"; then
    return 0
  fi

  LOCAL_KILL_WAIT_PIDS+=("${pid}")
  LOCAL_KILL_WAIT_PID_COUNT=$((LOCAL_KILL_WAIT_PID_COUNT + 1))
}

track_wait_pids_from_text() {
  local pids_text="${1:-}"
  local pid=""

  while IFS= read -r pid; do
    track_wait_pid "${pid}"
  done <<< "${pids_text}"
}

collect_pgid_pids() {
  local pgid="${1:-}"
  if [[ -z "${pgid}" ]]; then
    return 0
  fi
  pgrep -g "${pgid}" 2>/dev/null || true
}

wait_for_tracked_pids_exit() {
  if [[ "${LOCAL_KILL_WAIT_PID_COUNT}" -eq 0 ]]; then
    return 0
  fi

  echo "${LOG_PREFIX} Waiting for killed processes to exit..."
  if runtime_stop_wait_for_pids_exit "${LOCAL_KILL_WAIT_ATTEMPTS}" "${LOCAL_KILL_WAIT_PIDS[@]}"; then
    return 0
  fi

  local pid=""
  local -a live_pids=()
  local live_pid_count=0
  for pid in "${LOCAL_KILL_WAIT_PIDS[@]}"; do
    if runtime_stop_pid_is_alive "${pid}"; then
      live_pids+=("${pid}")
      live_pid_count=$((live_pid_count + 1))
    fi
  done

  if [[ "${live_pid_count}" -eq 0 ]]; then
    return 0
  fi

  echo "${LOG_PREFIX} ERROR: Timed out waiting for killed processes to exit: ${live_pids[*]}" >&2
  return 1
}

read_pid_file() {
  local pid_file="$1"
  if [[ ! -f "${pid_file}" ]]; then
    return 0
  fi
  cat "${pid_file}" 2>/dev/null || true
}

kill_pgid_force() {
  local pgid="$1"
  local desc="${2:-process group ${pgid}}"
  if [[ -z "${pgid}" ]]; then
    return 0
  fi
  echo "${LOG_PREFIX} Force killing ${desc} (pgid=${pgid})..."
  track_wait_pids_from_text "$(collect_pgid_pids "${pgid}")"
  kill -KILL "-${pgid}" >/dev/null 2>&1 || true
}

read_pid_pgid() {
  local pid="$1"
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  ps -o pgid= -p "${pid}" 2>/dev/null | tr -d '[:space:]'
}

describe_pid() {
  local pid="$1"
  if [[ -z "${pid}" ]]; then
    echo "unknown"
    return
  fi
  local cmd=""
  cmd="$(ps -o comm= -p "${pid}" 2>/dev/null || echo "dead")"
  case "${cmd}" in
    *with-logs*)
      echo "with-logs wrapper"
      ;;
    *concurrently*)
      echo "concurrent process runner"
      ;;
    *tsx*)
      echo "tsx process"
      ;;
    *esbuild*)
      echo "esbuild"
      ;;
    *node*)
      echo "Node.js"
      ;;
    *healthcheck*)
      echo "healthcheck monitor"
      ;;
    *realm-touch-heartbeat*)
      echo "local-edge realm heartbeat"
      ;;
    bash|sh)
      local full_cmd=""
      full_cmd="$(ps -o args= -p "${pid}" 2>/dev/null || echo "")"
      echo "shell (${full_cmd##*/})"
      ;;
    *)
      echo "${cmd}"
      ;;
  esac
}

local_edge_session_kill_collect_patterns() {
  local pattern=""
  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    printf '%s\n' "${pattern}"
  done <<< "${LOCAL_EDGE_SESSION_KILL_CHECKOUT_PATTERNS:-}"
}

run_optional_project_command_quietly() {
  local command_text="${1:-}"
  if [[ -z "${command_text}" ]]; then
    return 0
  fi

  bash -c "${command_text}" local-edge-session-kill "${PROJECT_ROOT}" >/dev/null 2>&1
}

start_message="${LOCAL_EDGE_SESSION_KILL_START_MESSAGE:-${LOG_PREFIX} Force killing all local-edge session processes...}"
echo "${start_message}"
echo "${LOG_PREFIX} Project: ${PROJECT_ROOT}"

child_pid="$(read_pid_file "${RUN_CHILD_PID_FILE}")"
child_pgid="$(read_pid_file "${RUN_CHILD_PGID_FILE}")"
shell_pid="$(read_pid_file "${RUN_SHELL_PID_FILE}")"

resolved_child_pgid="$(read_pid_pgid "${child_pid}" || true)"
if [[ -n "${resolved_child_pgid}" ]]; then
  child_pgid="${resolved_child_pgid}"
fi

if [[ -n "${child_pgid}" ]]; then
  child_desc="$(describe_pid "${child_pid}" || echo "session child")"
  kill_pgid_force "${child_pgid}" "session child (${child_desc})"
  kill_pgid_force "${child_pgid}" "session child (retry)"
fi

if [[ -n "${shell_pid}" ]]; then
  shell_desc="$(describe_pid "${shell_pid}" || echo "shell wrapper")"
  echo "${LOG_PREFIX} Killing shell wrapper (pid=${shell_pid}, type=${shell_desc})..."
  track_wait_pid "${shell_pid}"
  kill -KILL "${shell_pid}" >/dev/null 2>&1 || true
fi

if [[ -n "${child_pid}" ]]; then
  child_desc="$(describe_pid "${child_pid}" || echo "session child")"
  echo "${LOG_PREFIX} Killing session child (pid=${child_pid}, type=${child_desc})..."
  track_wait_pid "${child_pid}"
  kill -KILL "${child_pid}" >/dev/null 2>&1 || true
fi

session_patterns=()
while IFS= read -r pattern; do
  [[ -z "${pattern}" ]] && continue
  session_patterns+=("${pattern}")
done < <(local_edge_session_kill_collect_patterns)

if [[ "${#session_patterns[@]}" -gt 0 ]]; then
  checkout_session_pids="$(
    runtime_stop_collect_checkout_scoped_pids "${PROJECT_ROOT}" "${session_patterns[@]}"
  )"
  if [[ -n "${checkout_session_pids}" ]]; then
    echo "${LOG_PREFIX} Killing checkout session helper processes..."
    for pid in ${checkout_session_pids}; do
      pid_desc="$(describe_pid "${pid}" || echo "helper")"
      echo "${LOG_PREFIX}   -> killing ${pid_desc} (pid=${pid})"
      track_wait_pid "${pid}"
      kill -KILL "${pid}" >/dev/null 2>&1 || true
    done
  fi
fi

if [[ -n "${LOCAL_EDGE_SESSION_KILL_PLATFORM_STOP_MESSAGE:-}" ]]; then
  echo "${LOCAL_EDGE_SESSION_KILL_PLATFORM_STOP_MESSAGE}"
fi
run_optional_project_command_quietly "${LOCAL_EDGE_SESSION_KILL_PLATFORM_COMMAND:-}" || true

if [[ "${#session_patterns[@]}" -gt 0 ]]; then
  checkout_session_pids="$(
    runtime_stop_collect_checkout_scoped_pids "${PROJECT_ROOT}" "${session_patterns[@]}"
  )"
  if [[ -n "${checkout_session_pids}" ]]; then
    echo "${LOG_PREFIX} Force killing remaining checkout session helper processes..."
    for pid in ${checkout_session_pids}; do
      pid_desc="$(describe_pid "${pid}" || echo "helper")"
      echo "${LOG_PREFIX}   -> killing remaining ${pid_desc} (pid=${pid})"
      track_wait_pid "${pid}"
      kill -KILL "${pid}" >/dev/null 2>&1 || true
    done
  fi
fi

wait_for_tracked_pids_exit

cleanup_message="${LOCAL_EDGE_SESSION_KILL_CLEANUP_MESSAGE:-${LOG_PREFIX} Cleaning up PID files...}"
echo "${cleanup_message}"
rm -f \
  "${RUN_SHELL_PID_FILE}" \
  "${RUN_CHILD_PID_FILE}" \
  "${RUN_CHILD_PGID_FILE}" \
  "${RUN_HEALTHCHECK_PID_FILE}" \
  "${RUN_ENV_WATCHER_PID_FILE}" \
  "${RUN_HEARTBEAT_PID_FILE}"

completed_message="${LOCAL_EDGE_SESSION_KILL_COMPLETED_MESSAGE:-${LOG_PREFIX} Completed.}"
echo "${completed_message}"
