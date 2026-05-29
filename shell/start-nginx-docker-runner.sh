#!/usr/bin/env bash
# Reusable nginx-docker start runner. Project adapters provide the sourced shell library, plan
# command, command hooks, and operator remediation hints through environment variables.
set -euo pipefail

: "${LOCAL_EDGE_START_NGINX_DOCKER_SHELL_LIB:?LOCAL_EDGE_START_NGINX_DOCKER_SHELL_LIB is required}"
: "${LOCAL_EDGE_START_NGINX_DOCKER_PLAN_COMMAND:?LOCAL_EDGE_START_NGINX_DOCKER_PLAN_COMMAND is required}"
# shellcheck source=/dev/null
source "${LOCAL_EDGE_START_NGINX_DOCKER_SHELL_LIB}"
local_edge_source_env_file_if_present

PLAN_ASSIGNMENTS="$(
  LOCAL_EDGE_PROJECT_ROOT="${LOCAL_EDGE_PROJECT_ROOT}" \
    bash -lc "${LOCAL_EDGE_START_NGINX_DOCKER_PLAN_COMMAND}"
)"
eval "${PLAN_ASSIGNMENTS}"

local_edge_start_nginx_docker_hook() {
  local hook_command="$1"
  if [[ -z "${hook_command}" ]]; then
    return 0
  fi
  METHOD="${METHOD}" LISTEN_HOST="${LISTEN_HOST}" PORT="${PORT}" bash -lc "${hook_command}"
}

local_edge_start_nginx_docker_print_loopback_hint() {
  local hint="${LOCAL_EDGE_START_NGINX_DOCKER_LOOPBACK_ALIAS_HINT:-}"
  if [[ -n "${hint}" ]]; then
    echo "[local-edge:${METHOD}] ${hint}"
  fi
}

local_edge_start_nginx_docker_fail_for_legacy_host_managed_conflict() {
  if ! local_edge_legacy_host_managed_proxy_conflict_present; then
    return 1
  fi

  echo "[local-edge:${METHOD}] ERROR: Detected a stale host-managed local-edge daemon on ${LISTEN_HOST}:${PORT}."
  echo "[local-edge:${METHOD}] The current local-edge standard is single-method nginx-docker. Remove the old host-level daemon explicitly before continuing."
  echo "[local-edge:${METHOD}] Required remediation:"
  echo "[local-edge:${METHOD}]   sudo launchctl bootout system/$(local_edge_legacy_host_managed_proxy_label)"
  echo "[local-edge:${METHOD}]   sudo rm -f $(local_edge_legacy_host_managed_proxy_plist_path)"
  echo "[local-edge:${METHOD}] Listening process details:"
  lsof -nP -iTCP@"${LISTEN_HOST}":"${PORT}" -sTCP:LISTEN || true
  exit 1
}

if [[ "${CUSTOM_LOOPBACK_REQUIRED}" == "true" ]]; then
  if ! local_edge_loopback_alias_exists "${LISTEN_HOST}"; then
    echo "[local-edge:${METHOD}] ERROR: Required custom loopback alias is missing for bind host ${LISTEN_HOST}."
    local_edge_start_nginx_docker_print_loopback_hint
    exit 1
  fi
fi

local_edge_ensure_docker_ready_for_startup

if ! local_edge_is_truthy "${LOCAL_EDGE_SKIP_RENDER:-false}"; then
  local_edge_start_nginx_docker_hook "${LOCAL_EDGE_START_NGINX_DOCKER_RENDER_COMMAND:-}"
fi

if ! local_edge_is_truthy "${LOCAL_EDGE_SKIP_SETUP:-false}"; then
  local_edge_start_nginx_docker_hook "${LOCAL_EDGE_START_NGINX_DOCKER_SETUP_COMMAND:-}"
fi

if local_edge_method_runtime_is_running "${METHOD}"; then
  echo "[local-edge:${METHOD}] Already running on ${LISTEN_HOST}:${PORT}."
  local_edge_write_artifact "${METHOD}.started" "method=${METHOD}
host=${LISTEN_HOST}
port=${PORT}
status=already-running"
  exit 0
fi

if local_edge_is_port_listening "${PORT}" "${LISTEN_HOST}"; then
  local_edge_start_nginx_docker_fail_for_legacy_host_managed_conflict
fi

if local_edge_is_port_listening "${PORT}" "${LISTEN_HOST}"; then
  echo "[local-edge:${METHOD}] ERROR: Another process is already listening on ${LISTEN_HOST}:${PORT}."
  echo "[local-edge:${METHOD}] Resolve the port conflict before starting ${METHOD}."
  lsof -nP -iTCP@"${LISTEN_HOST}":"${PORT}" -sTCP:LISTEN || true
  exit 1
fi

if [[ -z "${START_CMD}" ]]; then
  echo "[local-edge:${METHOD}] SKIP: LOCAL_EDGE_NGINX_DOCKER_START_CMD is not configured."
  if local_edge_should_fail_hard; then
    exit 1
  fi
  exit 0
fi

if ! local_edge_command_exists "${START_BIN}"; then
  echo "[local-edge:${METHOD}] WARNING: Start command binary '${START_BIN}' is unavailable."
  if local_edge_should_fail_hard; then
    exit 1
  fi
  exit 0
fi

local_edge_run_start_command "${METHOD}" "${START_CMD}"

if local_edge_wait_for_method_runtime "${METHOD}" "${TIMEOUT_SECONDS}"; then
  echo "[local-edge:${METHOD}] Started successfully on ${LISTEN_HOST}:${PORT}."
  local_edge_write_artifact "${METHOD}.started" "method=${METHOD}
host=${LISTEN_HOST}
port=${PORT}
status=started"
  exit 0
fi

echo "[local-edge:${METHOD}] WARNING: Start command completed but ${LISTEN_HOST}:${PORT} is not listening."
echo "[local-edge:${METHOD}] Last log lines:"
tail -n 40 "${LOCAL_EDGE_LOG_DIR}/${METHOD}.log" || true

if grep -q "bind: can't assign requested address" "${LOCAL_EDGE_LOG_DIR}/${METHOD}.log" 2>/dev/null; then
  if [[ "${LISTEN_HOST}" =~ ^127\. ]] && [[ "${LISTEN_HOST}" != "127.0.0.1" ]]; then
    echo "[local-edge:${METHOD}] ERROR: Docker bind failed for ${LISTEN_HOST}:${PORT} (custom loopback alias likely missing)."
    local_edge_start_nginx_docker_print_loopback_hint
  else
    echo "[local-edge:${METHOD}] ERROR: Docker bind failed for ${LISTEN_HOST}:${PORT}."
  fi
  exit 1
fi

if local_edge_should_fail_hard; then
  exit 1
fi
exit 0
