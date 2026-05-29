#!/usr/bin/env bash
# Reusable multi-method start runner. Project adapters provide sourced shell helpers and command
# hooks for render/setup/status and method-specific start execution.
set -euo pipefail

: "${LOCAL_EDGE_START_ALL_SHELL_LIB:?LOCAL_EDGE_START_ALL_SHELL_LIB is required}"
# shellcheck source=/dev/null
source "${LOCAL_EDGE_START_ALL_SHELL_LIB}"
local_edge_source_env_file_if_present

local_edge_start_all_hook() {
  local hook_command="$1"
  local method="$2"
  if [[ -z "${hook_command}" ]]; then
    return 0
  fi
  METHOD="${method}" bash -lc "${hook_command}"
}

local_edge_start_all_start_method() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      LOCAL_EDGE_SKIP_RENDER=true \
        LOCAL_EDGE_SKIP_SETUP=true \
        METHOD="${method}" \
        bash -lc "${LOCAL_EDGE_START_ALL_METHOD_COMMAND:?LOCAL_EDGE_START_ALL_METHOD_COMMAND is required}"
      ;;
    *)
      echo "[local-edge:start:all] Unsupported method '${method}'." >&2
      return 1
      ;;
  esac
}

echo "[local-edge:start:all] Starting all configured local-edge methods..."
if ! local_edge_is_truthy "${LOCAL_EDGE_SKIP_RENDER:-false}"; then
  local_edge_start_all_hook "${LOCAL_EDGE_START_ALL_RENDER_COMMAND:-}" "all"
fi

if ! local_edge_is_truthy "${LOCAL_EDGE_SKIP_SETUP:-false}"; then
  local_edge_start_all_hook "${LOCAL_EDGE_START_ALL_SETUP_COMMAND:-}" "all"
fi

while IFS= read -r method; do
  local_edge_start_all_start_method "${method}"
done < <(local_edge_configured_methods)

echo "[local-edge:start:all] Current status:"
local_edge_start_all_hook "${LOCAL_EDGE_START_ALL_STATUS_COMMAND:-}" "all"

if local_edge_is_truthy "${LOCAL_EDGE_STRICT_START:-false}"; then
  local_edge_start_all_hook "${LOCAL_EDGE_START_ALL_STRICT_STATUS_COMMAND:-}" "all" >/dev/null
fi

exit 0
