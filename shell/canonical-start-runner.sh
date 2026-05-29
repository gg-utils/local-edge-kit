#!/usr/bin/env bash
set -euo pipefail

canonical_start_required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "[local-edge] ERROR: ${name} is required for canonical start runner." >&2
    exit 2
  fi
  printf '%s\n' "${value}"
}

PROJECT_ROOT="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_PROJECT_ROOT)"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
SHELL_LIB="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_SHELL_LIB)"
FORMATTER_SCRIPT="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_FORMATTER_SCRIPT)"
INIT_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_INIT_COMMAND)"
RENDER_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_RENDER_COMMAND)"
SETUP_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_SETUP_COMMAND)"
DNS_AUDIT_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_DNS_AUDIT_COMMAND)"
SETUP_BOOTSTRAP_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_SETUP_BOOTSTRAP_COMMAND)"
WITH_LOGS_COMMAND="$(canonical_start_required_env LOCAL_EDGE_CANONICAL_WITH_LOGS_COMMAND)"
DEFAULT_METHOD="${LOCAL_EDGE_CANONICAL_DEFAULT_METHOD:-nginx-docker}"
ENV_FILE="${LOCAL_EDGE_CANONICAL_ENV_FILE:-${LOCAL_EDGE_ENV_FILE:-${PROJECT_ROOT}/.env.local-edge}}"
FORCE_BOOTSTRAP="false"
PRECHECK_ONLY="false"
AUDIT_METHOD=""
LOCAL_EDGE_CANONICAL_FORMATTER_ACTIVE="false"

export LOCAL_EDGE_PROJECT_ROOT="${PROJECT_ROOT}"

if [[ ! -f "${SHELL_LIB}" ]]; then
  echo "[local-edge] ERROR: canonical shell library not found: ${SHELL_LIB}" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "${SHELL_LIB}"

if local_edge_is_truthy "${LOCAL_EDGE_CANONICAL_FORCE_BOOTSTRAP:-false}"; then
  FORCE_BOOTSTRAP="true"
fi
if local_edge_is_truthy "${LOCAL_EDGE_STARTUP_CLI_CANONICAL_FORCE_BOOTSTRAP:-false}"; then
  FORCE_BOOTSTRAP="true"
fi
if local_edge_is_truthy "${LOCAL_EDGE_STARTUP_CLI_CANONICAL_PREFLIGHT_ONLY:-false}"; then
  PRECHECK_ONLY="true"
fi

read_env_value() {
  local file_path="$1"
  local key="$2"
  local escaped_key=""
  local line=""
  escaped_key="$(printf '%s' "${key}" | sed 's/[][^$.*/+?{}()|\\]/\\&/g')"
  line="$(grep -E "^${escaped_key}=" "${file_path}" | tail -1 || true)"
  if [[ -z "${line}" ]]; then
    echo ""
    return 0
  fi
  echo "${line#*=}" | tr -d '"' | tr -d "'"
}

canonical_start_run_command() {
  local command_text="$1"
  shift || true
  bash -c "${command_text}" local-edge-canonical-start "${PROJECT_ROOT}" "$@"
}

canonical_start_enable_formatter() {
  local requested_output_format="${LOCAL_EDGE_LOG_OUTPUT_FORMAT:-}"

  if [[ -z "${requested_output_format}" && -f "${ENV_FILE}" ]]; then
    requested_output_format="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_LOG_OUTPUT_FORMAT")"
  fi

  if [[ "${requested_output_format}" == "raw" ]]; then
    export LOCAL_EDGE_LOG_FORMATTER_ACTIVE="false"
    return 0
  fi

  if local_edge_is_truthy "${LOCAL_EDGE_LOG_FORMATTER_ACTIVE:-false}"; then
    return 0
  fi

  export LOCAL_EDGE_LOG_FORMATTER_ACTIVE="true"
  exec 3>&1 4>&2
  exec > >(bash "${FORMATTER_SCRIPT}") 2>&1
  LOCAL_EDGE_CANONICAL_FORMATTER_ACTIVE="true"
}

canonical_start_disable_formatter() {
  if [[ "${LOCAL_EDGE_CANONICAL_FORMATTER_ACTIVE}" != "true" ]]; then
    return 0
  fi

  exec 1>&3 2>&4
  exec 3>&- 4>&-
  LOCAL_EDGE_CANONICAL_FORMATTER_ACTIVE="false"
}

resolve_audit_method() {
  local configured_value="${LOCAL_EDGE_AUDIT_METHOD:-}"
  if [[ "${configured_value}" == "all" ]]; then
    local_edge_warn "LOCAL_EDGE_AUDIT_METHOD=all is deprecated in single-method mode. Falling back to primary method."
  fi
  if [[ -n "${configured_value}" ]] && local_edge_is_supported_method "${configured_value}"; then
    echo "${configured_value}"
    return 0
  fi

  if local_edge_primary_method >/dev/null 2>&1; then
    local_edge_primary_method
    return 0
  fi

  echo "${DEFAULT_METHOD}"
}

canonical_start_dnsmasq_listener_running() {
  local listen_address="${LOCAL_EDGE_SPLIT_DNS_LISTEN_ADDRESS:-127.0.0.1}"
  local listen_port="${LOCAL_EDGE_SPLIT_DNS_PORT:-53535}"

  if lsof -nP -iUDP@"${listen_address}":"${listen_port}" >/dev/null 2>&1 || \
    lsof -nP -iTCP@"${listen_address}":"${listen_port}" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

canonical_start_bootstrap_reason_missing_loopback_alias() {
  local method="$1"
  local listen_host=""
  listen_host="$(local_edge_method_listen_host "${method}")"

  if [[ ! "${listen_host}" =~ ^127\. ]]; then
    return 1
  fi

  if [[ "${listen_host}" == "127.0.0.1" ]]; then
    return 1
  fi

  if local_edge_loopback_alias_exists "${listen_host}"; then
    return 1
  fi

  printf "missing loopback alias %s for %s" "${listen_host}" "${method}"
  return 0
}

canonical_start_bootstrap_reason_missing_dns_listener() {
  if canonical_start_dnsmasq_listener_running; then
    return 1
  fi

  printf "split-DNS listener %s:%s is not running" \
    "${LOCAL_EDGE_SPLIT_DNS_LISTEN_ADDRESS:-127.0.0.1}" \
    "${LOCAL_EDGE_SPLIT_DNS_PORT:-53535}"
  return 0
}

run_canonical_preflight_checks() {
  local audit_method="$1"
  local strict_flag="$2"
  local render_exit_code=0
  local setup_exit_code=0
  local dns_exit_code=0

  set +e
  canonical_start_run_command "${RENDER_COMMAND}" "${audit_method}" "${strict_flag}"
  render_exit_code=$?
  canonical_start_run_command "${SETUP_COMMAND}" "${audit_method}" "${strict_flag}"
  setup_exit_code=$?
  canonical_start_run_command "${DNS_AUDIT_COMMAND}" "${audit_method}" "${strict_flag}"
  dns_exit_code=$?
  set -e

  if [[ "${render_exit_code}" -ne 0 || "${setup_exit_code}" -ne 0 || "${dns_exit_code}" -ne 0 ]]; then
    return 1
  fi
  return 0
}

canonical_start_enable_formatter
trap canonical_start_disable_formatter EXIT

if [[ ! -f "${ENV_FILE}" ]]; then
  local_edge_info "No .env.local-edge found. Running init first."
  canonical_start_run_command "${INIT_COMMAND}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  local_edge_error "Unable to initialize env file: ${ENV_FILE}"
  exit 1
fi

export LOCAL_EDGE_ENV_FILE="${ENV_FILE}"
local_edge_source_env_file_if_present

local_edge_section "Local Edge: Canonical Preflight"

raw_developer_slug="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_DEVELOPER_SLUG")"
normalized_developer_slug="$(local_edge_slugify "${raw_developer_slug}")"
raw_methods="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_METHODS")"
raw_primary_method="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_PRIMARY_METHOD")"
raw_root_zone="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_ROOT_ZONE")"
raw_env_slug="$(read_env_value "${ENV_FILE}" "LOCAL_EDGE_ENV_SLUG")"

supported_methods_count=0
supported_methods_csv=""
if [[ -n "${raw_methods}" ]]; then
  for candidate_method in ${raw_methods//,/ }; do
    if ! local_edge_is_supported_method "${candidate_method}"; then
      continue
    fi
    if [[ ",${supported_methods_csv}," == *",${candidate_method},"* ]]; then
      continue
    fi
    if [[ -z "${supported_methods_csv}" ]]; then
      supported_methods_csv="${candidate_method}"
    else
      supported_methods_csv="${supported_methods_csv},${candidate_method}"
    fi
    supported_methods_count=$((supported_methods_count + 1))
  done
fi

needs_init="false"
if [[ -z "${raw_developer_slug}" || "${normalized_developer_slug}" == "default" ]]; then
  needs_init="true"
fi
if [[ -z "${raw_methods}" || -z "${raw_primary_method}" || -z "${raw_root_zone}" || -z "${raw_env_slug}" ]]; then
  needs_init="true"
fi
if [[ "${supported_methods_count}" -ne 1 ]]; then
  needs_init="true"
fi

if [[ "${needs_init}" == "true" ]]; then
  local_edge_info "Detected incomplete local-edge env values. Running init normalization."
  canonical_start_run_command "${INIT_COMMAND}"
  local_edge_source_env_file_if_present
fi

AUDIT_METHOD="$(resolve_audit_method)"

bootstrap_required="false"
bootstrap_reason=""
if local_edge_is_truthy "${FORCE_BOOTSTRAP}"; then
  bootstrap_required="true"
  bootstrap_reason="forced by --force-bootstrap"
  local_edge_info "Forcing setup bootstrap (--force-bootstrap)."
fi

if [[ "${bootstrap_required}" == "false" ]]; then
  loopback_reason="$(canonical_start_bootstrap_reason_missing_loopback_alias "${AUDIT_METHOD}" || true)"
  if [[ -n "${loopback_reason}" ]]; then
    bootstrap_required="true"
    bootstrap_reason="${loopback_reason}"
  fi
fi

if [[ "${bootstrap_required}" == "false" ]]; then
  dns_listener_reason="$(canonical_start_bootstrap_reason_missing_dns_listener || true)"
  if [[ -n "${dns_listener_reason}" ]]; then
    bootstrap_required="true"
    bootstrap_reason="${dns_listener_reason}"
  fi
fi

if [[ "${bootstrap_required}" == "true" && -n "${bootstrap_reason}" && "${bootstrap_reason}" != "forced by --force-bootstrap" ]]; then
  local_edge_warn "Detected bootstrap prerequisites missing (${bootstrap_reason})."
fi

if [[ "${bootstrap_required}" == "false" ]]; then
  local_edge_info "Running strict preflight audit for canonical startup (method='${AUDIT_METHOD}')."
  if ! run_canonical_preflight_checks "${AUDIT_METHOD}" --strict; then
    bootstrap_required="true"
    local_edge_warn "Strict preflight failed; bootstrap recovery is required."
  else
    local_edge_success "Strict preflight passed for method='${AUDIT_METHOD}'."
  fi
fi

if [[ "${bootstrap_required}" == "true" ]]; then
  local_edge_section "Local Edge: Bootstrap Recovery"
  local_edge_info "Bootstrap scope: method='${AUDIT_METHOD}'"
  canonical_start_run_command "${SETUP_BOOTSTRAP_COMMAND}" "${AUDIT_METHOD}"
fi

if [[ "${PRECHECK_ONLY}" == "true" ]]; then
  local_edge_section "Local Edge: Final Preflight"
  local_edge_info "Running final strict preflight audit (method='${AUDIT_METHOD}')."
  if ! run_canonical_preflight_checks "${AUDIT_METHOD}" --strict; then
    local_edge_warn "Final strict preflight failed; bootstrap may be incomplete."
  fi
  local_edge_success "Preflight-only mode complete."
  exit 0
fi

local_edge_section "Local Edge: Final Preflight"
local_edge_info "Running final strict preflight audit (method='${AUDIT_METHOD}')."
if ! run_canonical_preflight_checks "${AUDIT_METHOD}" --strict; then
  local_edge_warn "Final strict preflight failed; bootstrap may be incomplete."
fi
local_edge_success "Preflight complete. Handing off to interactive runtime."

canonical_start_disable_formatter
trap - EXIT

exec bash -c "${WITH_LOGS_COMMAND}" local-edge-canonical-start "${PROJECT_ROOT}"
