#!/usr/bin/env bash
set -euo pipefail

setup_bootstrap_required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "[local-edge] ERROR: ${name} is required for setup bootstrap runner." >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

PROJECT_ROOT="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_PROJECT_ROOT)"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
SHELL_LIB="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_SHELL_LIB)"
RENDER_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_RENDER_COMMAND)"
LOOPBACK_ALIAS_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_LOOPBACK_ALIAS_COMMAND)"
SETUP_VALIDATE_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_SETUP_VALIDATE_COMMAND)"
TLS_TRUST_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_TLS_TRUST_COMMAND)"
SPLIT_DNS_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_SPLIT_DNS_COMMAND)"
STATUS_COMMAND="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_STATUS_COMMAND)"
DEFAULT_ROOT_ZONE="$(setup_bootstrap_required_env LOCAL_EDGE_SETUP_BOOTSTRAP_DEFAULT_ROOT_ZONE)"
RESOLVER_DIR="${LOCAL_EDGE_SETUP_BOOTSTRAP_RESOLVER_DIR:-/etc/resolver}"
LEGACY_DAEMON_MESSAGE="${LOCAL_EDGE_SETUP_BOOTSTRAP_LEGACY_DAEMON_MESSAGE:-[local-edge:setup:bootstrap] Host-managed legacy daemon bootstrap is not part of configured local-edge mode.}"
export LOCAL_EDGE_PROJECT_ROOT="${PROJECT_ROOT}"

if [[ ! -f "${SHELL_LIB}" ]]; then
  echo "[local-edge] ERROR: setup bootstrap shell library not found: ${SHELL_LIB}" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "${SHELL_LIB}"
local_edge_source_env_file_if_present

METHOD="$(local_edge_primary_method)"
WRITE_ARTIFACT="true"
SKIP_TLS_TRUST="false"
SKIP_SPLIT_DNS="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method)
      METHOD="${2:-}"
      shift 2
      ;;
    --skip-tls-trust)
      SKIP_TLS_TRUST="true"
      shift
      ;;
    --skip-split-dns)
      SKIP_SPLIT_DNS="true"
      shift
      ;;
    --no-artifact)
      WRITE_ARTIFACT="false"
      shift
      ;;
    *)
      echo "[local-edge:setup:bootstrap] Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${METHOD}" ]]; then
  echo "[local-edge:setup:bootstrap] --method requires a value." >&2
  exit 2
fi

if [[ "${METHOD}" != "all" ]] && ! local_edge_is_supported_method "${METHOD}"; then
  echo "[local-edge:setup:bootstrap] Unsupported --method '${METHOD}'." >&2
  exit 2
fi

scope_includes_method() {
  local target_method="$1"
  if [[ "${METHOD}" == "all" ]]; then
    local_edge_method_is_configured "${target_method}"
    return $?
  fi
  [[ "${METHOD}" == "${target_method}" ]]
}

scope_requires_nondefault_loopback_alias() {
  local scoped_method=""
  local listen_host=""
  while IFS= read -r scoped_method; do
    if [[ -z "${scoped_method}" ]]; then
      continue
    fi
    listen_host="$(local_edge_method_listen_host "${scoped_method}")"
    if [[ "${listen_host}" =~ ^127\. ]] && [[ "${listen_host}" != "127.0.0.1" ]] && ! local_edge_loopback_alias_exists "${listen_host}"; then
      return 0
    fi
  done < <(
    if [[ "${METHOD}" == "all" ]]; then
      local_edge_configured_methods
    else
      printf "%s\n" "${METHOD}"
    fi
  )
  return 1
}

resolver_file_requires_privileged_fix() {
  local root_zone="${LOCAL_EDGE_ROOT_ZONE:-${DEFAULT_ROOT_ZONE}}"
  local resolver_path="${RESOLVER_DIR}/${root_zone}"

  if [[ ! -d "${RESOLVER_DIR}" ]]; then
    return 0
  fi

  if [[ ! -f "${resolver_path}" ]]; then
    return 0
  fi

  if [[ ! -w "${resolver_path}" ]]; then
    return 0
  fi

  return 1
}

setup_bootstrap_requires_sudo() {
  if resolver_file_requires_privileged_fix; then
    return 0
  fi

  if scope_requires_nondefault_loopback_alias; then
    return 0
  fi

  return 1
}

ensure_resolver_file_ready() {
  local root_zone="${LOCAL_EDGE_ROOT_ZONE:-${DEFAULT_ROOT_ZONE}}"
  local resolver_path="${RESOLVER_DIR}/${root_zone}"
  local owner_user="${USER:-$(id -un)}"
  local owner_group=""
  owner_group="$(id -gn "${owner_user}" 2>/dev/null || true)"
  if [[ -z "${owner_group}" ]]; then
    owner_group="staff"
  fi

  echo "[local-edge:setup:bootstrap] Ensuring resolver file exists and is writable: ${resolver_path}"

  if [[ ! -d "${RESOLVER_DIR}" ]]; then
    sudo mkdir -p "${RESOLVER_DIR}"
  fi

  if [[ ! -f "${resolver_path}" ]]; then
    sudo touch "${resolver_path}"
  fi

  if [[ ! -w "${resolver_path}" ]]; then
    sudo chown "${owner_user}:${owner_group}" "${resolver_path}"
    sudo chmod 664 "${resolver_path}"
  fi

  if [[ ! -w "${resolver_path}" ]]; then
    echo "[local-edge:setup:bootstrap] ERROR: resolver file is still not writable: ${resolver_path}" >&2
    exit 1
  fi
}

setup_bootstrap_run_command() {
  local command_text="$1"
  shift || true
  bash -c "${command_text}" local-edge-setup-bootstrap "${PROJECT_ROOT}" "$@"
}

local_edge_section "Bootstrap: Recover Local Edge Prerequisites"
echo "[local-edge:setup:bootstrap] Starting centralized setup bootstrap for method scope '${METHOD}'."
echo "[local-edge:setup:bootstrap] This flow may prompt for sudo or package-manager installs (resolver, DNS listener, custom loopback alias, launchd)."

if [[ "${EUID}" != "0" ]]; then
  if setup_bootstrap_requires_sudo; then
    if [[ ! -t 0 ]]; then
      echo "[local-edge:setup:bootstrap] ERROR: interactive terminal required for sudo prompts." >&2
      echo "[local-edge:setup:bootstrap] Re-run this command directly in your terminal session." >&2
      exit 1
    fi
    sudo -v
  else
    echo "[local-edge:setup:bootstrap] No privileged bootstrap actions required for current scope."
  fi
else
  echo "[local-edge:setup:bootstrap] Running as root; privileged bootstrap actions are available."
fi

ensure_resolver_file_ready

local_edge_section "Bootstrap: Generate Config Artifacts"
echo "[local-edge:setup:bootstrap] Rendering config artifacts for scope '${METHOD}'..."
setup_bootstrap_run_command "${RENDER_COMMAND}" "${METHOD}"

if scope_requires_nondefault_loopback_alias; then
  echo "[local-edge:setup:bootstrap] Applying custom loopback aliases for scope '${METHOD}'..."
  setup_bootstrap_run_command "${LOOPBACK_ALIAS_COMMAND}" "${METHOD}"
else
  echo "[local-edge:setup:bootstrap] Custom loopback aliases are not required for current scope/config."
fi

echo "[local-edge:setup:bootstrap] Running pre-bootstrap setup validation (non-strict)..."
setup_bootstrap_run_command "${SETUP_VALIDATE_COMMAND}" "${METHOD}" "--no-strict"

local_edge_section "Bootstrap: Restore Trust and DNS"
echo "${LEGACY_DAEMON_MESSAGE}"

LOCAL_EDGE_TLS_MODE_NORMALIZED="$(printf "%s" "${LOCAL_EDGE_TLS_MODE:-mkcert}" | tr '[:upper:]' '[:lower:]')"
if [[ "${SKIP_TLS_TRUST}" == "true" ]]; then
  echo "[local-edge:setup:bootstrap] Skipping TLS trust step (--skip-tls-trust)."
elif [[ "${LOCAL_EDGE_TLS_MODE_NORMALIZED}" == "mkcert" ]]; then
  echo "[local-edge:setup:bootstrap] Installing/confirming mkcert trust..."
  setup_bootstrap_run_command "${TLS_TRUST_COMMAND}" "${METHOD}"
else
  echo "[local-edge:setup:bootstrap] TLS trust step skipped (LOCAL_EDGE_TLS_MODE='${LOCAL_EDGE_TLS_MODE_NORMALIZED}')."
fi

if [[ "${SKIP_SPLIT_DNS}" == "true" ]]; then
  echo "[local-edge:setup:bootstrap] Skipping split-DNS apply (--skip-split-dns)."
else
  echo "[local-edge:setup:bootstrap] Applying split-DNS mapping..."
  setup_bootstrap_run_command "${SPLIT_DNS_COMMAND}" "${METHOD}"
fi

local_edge_section "Bootstrap: Final Validation"
echo "[local-edge:setup:bootstrap] Running final strict setup validation..."
setup_bootstrap_run_command "${SETUP_VALIDATE_COMMAND}" "${METHOD}" "--strict"

echo "[local-edge:setup:bootstrap] Final status snapshot:"
setup_bootstrap_run_command "${STATUS_COMMAND}" "${METHOD}"

if [[ "${WRITE_ARTIFACT}" == "true" ]]; then
  RUN_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local_edge_write_artifact "setup-bootstrap-last-run.txt" "runAt=${RUN_AT}
method=${METHOD}
skipTlsTrust=${SKIP_TLS_TRUST}
skipSplitDns=${SKIP_SPLIT_DNS}
status=ok"
fi

local_edge_success "Bootstrap recovery completed."
