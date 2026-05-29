#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

local_edge_with_logs_required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "[local-edge] ERROR: ${name} is required for with-logs runner." >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

PROJECT_ROOT="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_PROJECT_ROOT)"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
RUN_LOG_DIR="${LOCAL_EDGE_WITH_LOGS_RUN_LOG_DIR:-${PROJECT_ROOT}/logs/local-edge/runs}"
RUN_STATE_DIR="${LOCAL_EDGE_WITH_LOGS_RUN_STATE_DIR:-${PROJECT_ROOT}/.tmp/local-edge/run}"
FORMATTER_SCRIPT="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_FORMATTER_SCRIPT)"
HELPER_TS="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_HELPER_TS)"
CHECKOUT_KIND_COMMAND="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_CHECKOUT_KIND_COMMAND)"
ROOT_RUNTIME_COMMAND="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_ROOT_RUNTIME_COMMAND)"
DELEGATED_RUNTIME_COMMAND="$(local_edge_with_logs_required_env LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_COMMAND)"
DEFAULT_CHECKOUT_KIND="${LOCAL_EDGE_WITH_LOGS_DEFAULT_CHECKOUT_KIND:-}"
DELEGATED_CHECKOUT_KIND="${LOCAL_EDGE_WITH_LOGS_DELEGATED_CHECKOUT_KIND:-}"
RUNTIME_STOP_LIB="${LOCAL_EDGE_WITH_LOGS_RUNTIME_STOP_LIB:-${PACKAGE_SHELL_DIR}/runtime-stop-lib.sh}"
RUN_SHELL_PID_FILE="${RUN_STATE_DIR}/local-session-shell.pid"
RUN_CHILD_PID_FILE="${RUN_STATE_DIR}/local-session-child.pid"
RUN_CHILD_PGID_FILE="${RUN_STATE_DIR}/local-session-child.pgid"
RUN_HEALTHCHECK_PID_FILE="${RUN_STATE_DIR}/local-session-healthcheck.pid"
RUN_ENV_WATCHER_PID_FILE="${RUN_STATE_DIR}/local-session-env-watch.pid"
RUN_HEARTBEAT_PID_FILE="${RUN_STATE_DIR}/local-session-heartbeat.pid"
RUN_STATE_OWNER="false"

if [[ ! -f "${RUNTIME_STOP_LIB}" ]]; then
  echo "[local-edge] ERROR: runtime stop shell library not found: ${RUNTIME_STOP_LIB}" >&2
  exit 2
fi
# shellcheck source=./runtime-stop-lib.sh
source "${RUNTIME_STOP_LIB}"

mkdir -p "${RUN_LOG_DIR}"
mkdir -p "${RUN_STATE_DIR}"

if [[ "${LOCAL_EDGE_RUN_STATE_OWNER_ACTIVE:-false}" != "true" ]]; then
  RUN_STATE_OWNER="true"
  export LOCAL_EDGE_RUN_STATE_OWNER_ACTIVE="true"
fi

local_edge_with_logs_helper() {
  npx tsx "${HELPER_TS}" "$@"
}

local_edge_shutdown_verbose_enabled() {
  case "${LOCAL_EDGE_SHUTDOWN_VERBOSE:-true}" in
    0|false|FALSE|no|NO|never)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

local_edge_parent_log() {
  local message="$1"
  local line="${LOCAL_EDGE_WITH_LOGS_SHUTDOWN_PREFIX}${message}"

  printf "%s\n" "${line}" >> "${LOG_FILE}"
  if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
    printf "%s\n" "${line}" | bash "${FORMATTER_SCRIPT}" >&2
  else
    printf "%s\n" "${line}" >&2
  fi
}

local_edge_parent_debug_log() {
  if local_edge_shutdown_verbose_enabled; then
    local_edge_parent_log "$1"
  fi
}

if [[ -z "${LOCAL_EDGE_COLOR:-}" ]]; then
  export LOCAL_EDGE_COLOR="1"
fi

export LOCAL_EDGE_LOG_OUTPUT_FORMAT="${LOCAL_EDGE_LOG_OUTPUT_FORMAT:-formatted}"
IFS=$'\t' read -r LOCAL_EDGE_LOG_OUTPUT_FORMAT_RESOLVED LOCAL_EDGE_FORMATTER_ENABLED LOCAL_EDGE_LOG_FORMATTER_ACTIVE_VALUE < <(
  local_edge_with_logs_helper resolve-formatter-state
)
LOCAL_EDGE_WITH_LOGS_SHUTDOWN_PREFIX="$(
  local_edge_with_logs_helper print-shutdown-prefix
)"

if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" && ! -f "${FORMATTER_SCRIPT}" ]]; then
  echo "[local-edge] ERROR: formatter script not found: ${FORMATTER_SCRIPT}" >&2
  exit 2
fi

resolve_checkout_kind() {
  local resolved_value=""

  if ! resolved_value="$(
    bash -c "${CHECKOUT_KIND_COMMAND}" local-edge-with-logs-checkout-kind "${PROJECT_ROOT}"
  )"; then
    local checkout_kind_error_line=""
    checkout_kind_error_line="$(
      local_edge_with_logs_helper format-checkout-kind-error \
        --project-root "${PROJECT_ROOT}"
    )"
    if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
      printf '%s\n' "${checkout_kind_error_line}" | bash "${FORMATTER_SCRIPT}"
    else
      printf '%s\n' "${checkout_kind_error_line}"
    fi
    exit 1
  fi

  printf '%s\n' "${resolved_value}"
}

color_enabled="false"
if [[ -z "${NO_COLOR:-}" ]] && [[ "${LOCAL_EDGE_COLOR}" != "0" ]] && [[ "${LOCAL_EDGE_COLOR}" != "false" ]]; then
  if [[ "${LOCAL_EDGE_COLOR}" == "1" || "${LOCAL_EDGE_COLOR}" == "true" || -t 1 ]]; then
    color_enabled="true"
  fi
fi

TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
LOG_FILE="${RUN_LOG_DIR}/local-edge-${TIMESTAMP}.log"
LATEST_LINK="${RUN_LOG_DIR}/latest.log"

ln -sfn "local-edge-${TIMESTAMP}.log" "${LATEST_LINK}"

WITH_LOGS_PRELUDE="$(
  local_edge_with_logs_helper print-prelude --log-file "${LOG_FILE}"
)"

printf "%s\n" "${WITH_LOGS_PRELUDE}" >> "${LOG_FILE}"
if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
  printf "%s\n" "${WITH_LOGS_PRELUDE}" | bash "${FORMATTER_SCRIPT}"
else
  printf "%s\n" "${WITH_LOGS_PRELUDE}"
fi

if [[ "${RUN_STATE_OWNER}" == "true" ]]; then
  read_pid_file() {
    local pid_file="$1"
    if [[ ! -f "${pid_file}" ]]; then
      return 0
    fi

    cat "${pid_file}" 2>/dev/null || true
  }

  reclaim_existing_local_session() {
    local recorded_shell_pid=""
    local recorded_child_pid=""
    local recorded_child_pgid=""

    recorded_shell_pid="$(read_pid_file "${RUN_SHELL_PID_FILE}")"
    recorded_child_pid="$(read_pid_file "${RUN_CHILD_PID_FILE}")"
    recorded_child_pgid="$(read_pid_file "${RUN_CHILD_PGID_FILE}")"

    if [[ -z "${recorded_shell_pid}" && -z "${recorded_child_pid}" && -z "${recorded_child_pgid}" ]]; then
      return 0
    fi

    if [[ "${recorded_shell_pid}" == "$$" || "${recorded_child_pid}" == "$$" ]]; then
      return 0
    fi

    local reclaim_line=""
    reclaim_line="$(
      local_edge_with_logs_helper format-reclaim-notice \
        --project-root "${PROJECT_ROOT}"
    )"
    if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
      printf "%s\n" "${reclaim_line}" | bash "${FORMATTER_SCRIPT}"
    else
      printf "%s\n" "${reclaim_line}"
    fi

    if [[ -n "${recorded_child_pgid}" ]]; then
      kill -TERM "-${recorded_child_pgid}" >/dev/null 2>&1 || true
    fi

    runtime_stop_terminate_pid_list "${recorded_child_pid}" "${recorded_shell_pid}"

    rm -f \
      "${RUN_SHELL_PID_FILE}" \
      "${RUN_CHILD_PID_FILE}" \
      "${RUN_CHILD_PGID_FILE}" \
      "${RUN_HEALTHCHECK_PID_FILE}" \
      "${RUN_ENV_WATCHER_PID_FILE}" \
      "${RUN_HEARTBEAT_PID_FILE}"
  }

  reclaim_existing_local_session
  printf "%s\n" "$$" > "${RUN_SHELL_PID_FILE}"
fi

read_child_pgid() {
  local child_pid="$1"
  if [[ -z "${child_pid}" ]]; then
    return 1
  fi

  ps -o pgid= -p "${child_pid}" 2>/dev/null | tr -d '[:space:]'
}

local_edge_collect_runtime_stop_patterns() {
  local pattern=""
  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    printf '%s\n' "${pattern}"
  done <<< "${LOCAL_EDGE_WITH_LOGS_RUNTIME_STOP_PATTERNS:-}"
}

kill_runtime_process_group() {
  local child_pid=""
  local child_pgid=""
  local signaled_count=0
  local -a runtime_stop_patterns=()
  local pattern=""

  if [[ -f "${RUN_CHILD_PID_FILE}" ]]; then
    child_pid="$(cat "${RUN_CHILD_PID_FILE}" 2>/dev/null || true)"
    local_edge_parent_debug_log "Recorded runtime child pid: ${child_pid:-<empty>}."
  fi
  if [[ -f "${RUN_CHILD_PGID_FILE}" ]]; then
    child_pgid="$(cat "${RUN_CHILD_PGID_FILE}" 2>/dev/null || true)"
    local_edge_parent_debug_log "Recorded runtime process group: ${child_pgid:-<empty>}."
  fi
  if [[ -z "${child_pgid}" && -n "${child_pid}" ]]; then
    child_pgid="$(read_child_pgid "${child_pid}" || true)"
    local_edge_parent_debug_log "Resolved runtime process group from pid ${child_pid}: ${child_pgid:-<empty>}."
  fi

  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    runtime_stop_patterns+=("${pattern}")
  done < <(local_edge_collect_runtime_stop_patterns)

  local_edge_parent_log "Stopping remaining checkout-scoped runtime processes with SIGTERM."
  if [[ "${#runtime_stop_patterns[@]}" -gt 0 ]]; then
    while IFS= read -r term_pid; do
      [[ -z "${term_pid}" ]] && continue
      signaled_count=$((signaled_count + 1))
      local_edge_parent_debug_log "Sending SIGTERM to pid ${term_pid}."
      kill -TERM "${term_pid}" >/dev/null 2>&1 || true
    done < <(runtime_stop_collect_checkout_scoped_pids "${PROJECT_ROOT}" "${runtime_stop_patterns[@]}" 2>/dev/null || true)
  fi

  local_edge_parent_log "SIGTERM sent to ${signaled_count} checkout-scoped process(es)."
  return 0
}

kill_runtime_process_group_sigint() {
  local child_pid=""
  local child_pgid=""
  local signaled_count=0
  local -a runtime_stop_patterns=()
  local pattern=""

  if [[ -f "${RUN_CHILD_PID_FILE}" ]]; then
    child_pid="$(cat "${RUN_CHILD_PID_FILE}" 2>/dev/null || true)"
    local_edge_parent_debug_log "Recorded runtime child pid: ${child_pid:-<empty>}."
  fi
  if [[ -f "${RUN_CHILD_PGID_FILE}" ]]; then
    child_pgid="$(cat "${RUN_CHILD_PGID_FILE}" 2>/dev/null || true)"
    local_edge_parent_debug_log "Recorded runtime process group: ${child_pgid:-<empty>}."
  fi

  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    runtime_stop_patterns+=("${pattern}")
  done < <(local_edge_collect_runtime_stop_patterns)

  local_edge_parent_log "Forwarding SIGINT to checkout-scoped runtime processes."
  if [[ "${#runtime_stop_patterns[@]}" -gt 0 ]]; then
    while IFS= read -r int_pid; do
      [[ -z "${int_pid}" ]] && continue
      signaled_count=$((signaled_count + 1))
      local_edge_parent_debug_log "Sending SIGINT to pid ${int_pid}."
      kill -INT "${int_pid}" >/dev/null 2>&1 || true
    done < <(runtime_stop_collect_checkout_scoped_pids "${PROJECT_ROOT}" "${runtime_stop_patterns[@]}" 2>/dev/null || true)
  fi

  local_edge_parent_log "SIGINT forwarded to ${signaled_count} checkout-scoped process(es)."
  return 0
}

cleanup_local_session_state() {
  local_edge_parent_debug_log "Cleanup requested; runStateOwner=${RUN_STATE_OWNER}; project=${PROJECT_ROOT}."
  if [[ "${RUN_STATE_OWNER}" != "true" ]]; then
    local_edge_parent_debug_log "Skipping cleanup because this shell does not own the local-edge run state."
    return 0
  fi

  if [[ -f "${RUN_CHILD_PID_FILE}" ]]; then
    local child_pid
    child_pid="$(cat "${RUN_CHILD_PID_FILE}" 2>/dev/null || true)"
    local_edge_parent_debug_log "Recorded child pid before final cleanup: ${child_pid:-<empty>}."
    kill_runtime_process_group
    if [[ -n "${child_pid}" ]]; then
      local_edge_parent_debug_log "Waiting for recorded child pid ${child_pid}."
      wait "${child_pid}" >/dev/null 2>&1 || true
    fi
  fi

  if [[ -f "${RUN_SHELL_PID_FILE}" ]] && [[ "$(cat "${RUN_SHELL_PID_FILE}" 2>/dev/null || true)" == "$$" ]]; then
    local_edge_parent_debug_log "Removing local-session shell pid file."
    rm -f "${RUN_SHELL_PID_FILE}"
  fi
  rm -f \
    "${RUN_CHILD_PID_FILE}" \
    "${RUN_CHILD_PGID_FILE}" \
    "${RUN_HEALTHCHECK_PID_FILE}" \
    "${RUN_ENV_WATCHER_PID_FILE}" \
    "${RUN_HEARTBEAT_PID_FILE}"
  local_edge_parent_log "Local-edge run-state pid files cleaned up."
}

cleanup_with_signal_forward() {
  local_edge_parent_debug_log "Signal-forward cleanup requested; signal=${LOCAL_EDGE_SIGNAL:-unset}; project=${PROJECT_ROOT}."
  if [[ -n "${LOCAL_EDGE_SIGNAL:-}" ]]; then
    case "${LOCAL_EDGE_SIGNAL}" in
      INT)
        kill_runtime_process_group_sigint
        local_edge_parent_log "SIGINT forwarding complete; waiting for services to exit."
        return 0
        ;;
      TERM)
        kill_runtime_process_group
        local_edge_parent_log "SIGTERM forwarding complete; waiting for services to exit."
        return 0
        ;;
    esac
  fi
  local_edge_parent_debug_log "No signal was set; running normal cleanup."
  cleanup_local_session_state
}

cleanup_with_signal_forward_int() {
  export LOCAL_EDGE_SIGNAL="INT"
  local_edge_parent_log "SIGINT received; shutting down local-edge runtime gracefully."
  local_edge_parent_log "Project: ${PROJECT_ROOT}"
  cleanup_with_signal_forward
}

cleanup_with_signal_forward_term() {
  export LOCAL_EDGE_SIGNAL="TERM"
  local_edge_parent_log "SIGTERM received; shutting down local-edge runtime gracefully."
  local_edge_parent_log "Project: ${PROJECT_ROOT}"
  cleanup_with_signal_forward
}

local_edge_run_configured_runtime_command() {
  local project_root="$1"
  local formatter_active="$2"
  cd "${project_root}"
  export LOCAL_EDGE_LOG_FORMATTER_ACTIVE="${formatter_active}"
  if [[ -n "${DELEGATED_CHECKOUT_KIND}" && "${LOCAL_EDGE_RESOLVED_CHECKOUT_KIND:-${DEFAULT_CHECKOUT_KIND}}" == "${DELEGATED_CHECKOUT_KIND}" ]] && [[ "${LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_BYPASS:-false}" != "true" ]] && [[ "${LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_BYPASS:-false}" != "1" ]]; then
    bash -c "${DELEGATED_RUNTIME_COMMAND}" local-edge-with-logs-runtime "${project_root}"
  else
    bash -c "${ROOT_RUNTIME_COMMAND}" local-edge-with-logs-runtime "${project_root}"
  fi
}

local_edge_launch_runtime_child() {
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c '
      local_edge_run_configured_runtime_command() {
        local project_root="$1"
        local formatter_active="$2"
        cd "${project_root}"
        export LOCAL_EDGE_LOG_FORMATTER_ACTIVE="${formatter_active}"
        if [[ -n "${LOCAL_EDGE_WITH_LOGS_DELEGATED_CHECKOUT_KIND:-}" && "${LOCAL_EDGE_RESOLVED_CHECKOUT_KIND:-${LOCAL_EDGE_WITH_LOGS_DEFAULT_CHECKOUT_KIND:-}}" == "${LOCAL_EDGE_WITH_LOGS_DELEGATED_CHECKOUT_KIND:-}" ]] && [[ "${LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_BYPASS:-false}" != "true" ]] && [[ "${LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_BYPASS:-false}" != "1" ]]; then
          bash -c "${LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_COMMAND}" local-edge-with-logs-runtime "${project_root}"
        else
          bash -c "${LOCAL_EDGE_WITH_LOGS_ROOT_RUNTIME_COMMAND}" local-edge-with-logs-runtime "${project_root}"
        fi
      }
      local_edge_run_configured_runtime_command "$1" "$2"
    ' _ "${PROJECT_ROOT}" "${LOCAL_EDGE_LOG_FORMATTER_ACTIVE_VALUE}" "$@" &
  elif command -v python3 >/dev/null 2>&1; then
    LOCAL_EDGE_WITH_LOGS_PYTHON_PROJECT_ROOT="${PROJECT_ROOT}" \
      LOCAL_EDGE_WITH_LOGS_PYTHON_FORMATTER_ACTIVE="${LOCAL_EDGE_LOG_FORMATTER_ACTIVE_VALUE}" \
      python3 -c '
import os
import subprocess
import sys

project_root = os.environ["LOCAL_EDGE_WITH_LOGS_PYTHON_PROJECT_ROOT"]
formatter_active = os.environ["LOCAL_EDGE_WITH_LOGS_PYTHON_FORMATTER_ACTIVE"]
default_checkout_kind = os.environ.get("LOCAL_EDGE_WITH_LOGS_DEFAULT_CHECKOUT_KIND", "")
delegated_checkout_kind = os.environ.get("LOCAL_EDGE_WITH_LOGS_DELEGATED_CHECKOUT_KIND", "")
root_command = os.environ["LOCAL_EDGE_WITH_LOGS_ROOT_RUNTIME_COMMAND"]
delegated_command = os.environ["LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_COMMAND"]

os.chdir(project_root)
os.environ["LOCAL_EDGE_LOG_FORMATTER_ACTIVE"] = formatter_active
os.setsid()

if (
    delegated_checkout_kind != ""
    and os.environ.get("LOCAL_EDGE_RESOLVED_CHECKOUT_KIND", default_checkout_kind) == delegated_checkout_kind
    and os.environ.get("LOCAL_EDGE_WITH_LOGS_DELEGATED_RUNTIME_BYPASS", "false") not in ("true", "1")
):
    completed = subprocess.run(["bash", "-c", delegated_command, "local-edge-with-logs-runtime", project_root], check=False)
else:
    completed = subprocess.run(["bash", "-c", root_command, "local-edge-with-logs-runtime", project_root], check=False)
sys.exit(completed.returncode)
' "$@" &
  else
    (
      local_edge_run_configured_runtime_command "${PROJECT_ROOT}" "${LOCAL_EDGE_LOG_FORMATTER_ACTIVE_VALUE}"
    ) &
  fi
}

trap cleanup_with_signal_forward_int INT
trap cleanup_with_signal_forward_term TERM
trap cleanup_local_session_state EXIT

LOCAL_EDGE_RESOLVED_CHECKOUT_KIND="$(resolve_checkout_kind)"
export LOCAL_EDGE_RESOLVED_CHECKOUT_KIND

set +e
if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
  local_edge_launch_runtime_child > >(tee -a "${LOG_FILE}" | bash "${FORMATTER_SCRIPT}") 2>&1
else
  local_edge_launch_runtime_child > >(tee -a "${LOG_FILE}") 2>&1
fi
LOCAL_EDGE_CHILD_PID=$!

if [[ "${RUN_STATE_OWNER}" == "true" ]]; then
  printf "%s\n" "${LOCAL_EDGE_CHILD_PID}" > "${RUN_CHILD_PID_FILE}"
  read_child_pgid "${LOCAL_EDGE_CHILD_PID}" > "${RUN_CHILD_PGID_FILE}" 2>/dev/null || true
fi

wait "${LOCAL_EDGE_CHILD_PID}"
LOCAL_EDGE_EXIT_CODE=$?
set -e

LOCAL_EDGE_RUNTIME_EXIT_LINE="$(
  local_edge_with_logs_helper format-runtime-exit --exit-code "${LOCAL_EDGE_EXIT_CODE}"
)"
printf "%s\n" "${LOCAL_EDGE_RUNTIME_EXIT_LINE}" >> "${LOG_FILE}"
if [[ "${LOCAL_EDGE_FORMATTER_ENABLED}" == "true" ]]; then
  printf "%s\n" "${LOCAL_EDGE_RUNTIME_EXIT_LINE}" | bash "${FORMATTER_SCRIPT}"
else
  printf "%s\n" "${LOCAL_EDGE_RUNTIME_EXIT_LINE}"
fi
exit "${LOCAL_EDGE_EXIT_CODE}"
