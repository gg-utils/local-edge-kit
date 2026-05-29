#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

local_edge_session_stop_required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "[local-edge] ERROR: ${name} is required for session stop runner." >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

PROJECT_ROOT="$(local_edge_session_stop_required_env LOCAL_EDGE_SESSION_STOP_PROJECT_ROOT)"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
RUN_STATE_DIR="${LOCAL_EDGE_SESSION_STOP_RUN_STATE_DIR:-${PROJECT_ROOT}/.tmp/local-edge/run}"
RUNTIME_STOP_LIB="${LOCAL_EDGE_SESSION_STOP_RUNTIME_STOP_LIB:-${PACKAGE_SHELL_DIR}/runtime-stop-lib.sh}"
RUN_SHELL_PID_FILE="${RUN_STATE_DIR}/local-session-shell.pid"
RUN_CHILD_PID_FILE="${RUN_STATE_DIR}/local-session-child.pid"
RUN_CHILD_PGID_FILE="${RUN_STATE_DIR}/local-session-child.pgid"
LOG_PREFIX="${LOCAL_EDGE_SESSION_STOP_LOG_PREFIX:-[local-edge:session-stop]}"

if [[ ! -f "${RUNTIME_STOP_LIB}" ]]; then
  echo "${LOG_PREFIX} ERROR: runtime stop shell library not found: ${RUNTIME_STOP_LIB}" >&2
  exit 2
fi
# shellcheck source=./runtime-stop-lib.sh
source "${RUNTIME_STOP_LIB}"

read_pid_file() {
  local pid_file="$1"
  if [[ ! -f "${pid_file}" ]]; then
    return 0
  fi

  cat "${pid_file}" 2>/dev/null || true
}

kill_pgid_if_alive() {
  local pgid="$1"
  if [[ -z "${pgid}" ]]; then
    return 0
  fi
  kill -TERM "-${pgid}" >/dev/null 2>&1 || true
}

read_pid_pgid() {
  local pid="$1"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  ps -o pgid= -p "${pid}" 2>/dev/null | tr -d '[:space:]'
}

local_edge_session_stop_collect_patterns() {
  local pattern=""
  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    printf '%s\n' "${pattern}"
  done <<< "${LOCAL_EDGE_SESSION_STOP_CHECKOUT_PATTERNS:-}"
}

run_optional_project_command_quietly() {
  local command_text="${1:-}"
  if [[ -z "${command_text}" ]]; then
    return 0
  fi

  bash -c "${command_text}" local-edge-session-stop "${PROJECT_ROOT}" >/dev/null 2>&1
}

start_message="${LOCAL_EDGE_SESSION_STOP_START_MESSAGE:-${LOG_PREFIX} Stopping the active local-edge session tree...}"
echo "${start_message}"

child_pid="$(read_pid_file "${RUN_CHILD_PID_FILE}")"
child_pgid="$(read_pid_file "${RUN_CHILD_PGID_FILE}")"
shell_pid="$(read_pid_file "${RUN_SHELL_PID_FILE}")"

resolved_child_pgid="$(read_pid_pgid "${child_pid}" || true)"
if [[ -n "${resolved_child_pgid}" ]]; then
  child_pgid="${resolved_child_pgid}"
fi

kill_pgid_if_alive "${child_pgid}"
runtime_stop_terminate_pid_list "${child_pid}" "${shell_pid}"

session_patterns=()
while IFS= read -r pattern; do
  [[ -z "${pattern}" ]] && continue
  session_patterns+=("${pattern}")
done < <(local_edge_session_stop_collect_patterns)

if [[ "${#session_patterns[@]}" -gt 0 ]]; then
  checkout_session_pids="$(
    runtime_stop_collect_checkout_scoped_pids "${PROJECT_ROOT}" "${session_patterns[@]}"
  )"
  runtime_stop_terminate_pid_list "${checkout_session_pids}"
fi

run_optional_project_command_quietly "${LOCAL_EDGE_SESSION_STOP_PLATFORM_COMMAND:-}" || true

if ! run_optional_project_command_quietly "${LOCAL_EDGE_SESSION_STOP_MARK_INACTIVE_COMMAND:-}"; then
  warning_message="${LOCAL_EDGE_SESSION_STOP_MARK_INACTIVE_WARNING:-${LOG_PREFIX} WARNING: Unable to mark the current realm inactive after stopping local processes.}"
  echo "${warning_message}"
fi

if [[ -n "${LOCAL_EDGE_SESSION_STOP_PRESERVE_MESSAGE:-}" ]]; then
  echo "${LOCAL_EDGE_SESSION_STOP_PRESERVE_MESSAGE}"
fi
if [[ -n "${LOCAL_EDGE_SESSION_STOP_TEARDOWN_HINT:-}" ]]; then
  echo "${LOCAL_EDGE_SESSION_STOP_TEARDOWN_HINT}"
fi

rm -f "${RUN_SHELL_PID_FILE}" "${RUN_CHILD_PID_FILE}" "${RUN_CHILD_PGID_FILE}"

completed_message="${LOCAL_EDGE_SESSION_STOP_COMPLETED_MESSAGE:-${LOG_PREFIX} Completed.}"
echo "${completed_message}"
