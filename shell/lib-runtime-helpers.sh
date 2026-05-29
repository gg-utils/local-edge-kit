#!/usr/bin/env bash
# Reusable local-edge shell helpers for logging, env-file loading, method/env resolution,
# host/runtime probing, Docker-method inspection, strict utility checks, artifact execution, and
# interactive prompts. Consumer adapters define project-specific hooks for active env collection,
# log color, legacy artifact normalization, surface hostnames, and method URL-matrix printing.

local_edge_prepend_known_docker_cli_path_if_needed() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi

  local docker_bin_dir=""
  if [[ -x "/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
    docker_bin_dir="/Applications/Docker.app/Contents/Resources/bin"
  elif [[ -x "${HOME}/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
    docker_bin_dir="${HOME}/Applications/Docker.app/Contents/Resources/bin"
  fi

  if [[ -n "${docker_bin_dir}" ]]; then
    export PATH="${docker_bin_dir}:${PATH}"
  fi
}


local_edge_source_env_file_if_present() {
  local env_file="${LOCAL_EDGE_ENV_FILE:-${LOCAL_EDGE_PROJECT_ROOT}/.env.local-edge}"
  if [[ -f "${env_file}" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "${env_file}"
    set +a
    if local_edge_is_truthy "${LOCAL_EDGE_LOG_ENV_LOADS:-false}"; then
      local_edge_info "Loaded env file: ${env_file}"
    fi
  fi
}

local_edge_default_env_file() {
  printf "%s\n" "${LOCAL_EDGE_ENV_FILE:-${LOCAL_EDGE_PROJECT_ROOT}/.env.local-edge}"
}

local_edge_log_output_format() {
  local requested="${LOCAL_EDGE_LOG_OUTPUT_FORMAT:-formatted}"
  case "${requested}" in
    raw)
      printf '%s\n' "raw"
      ;;
    *)
      printf '%s\n' "formatted"
      ;;
  esac
}

local_edge_log_formatter_requested() {
  [[ "$(local_edge_log_output_format)" == "formatted" ]]
}

local_edge_info() {
  if local_edge_log_color_enabled; then
    printf "\033[1;36m[local-edge]\033[0m %s\n" "$*"
    return 0
  fi
  echo "[local-edge] $*"
}

local_edge_success() {
  if local_edge_log_color_enabled; then
    printf "\033[1;32m[local-edge]\033[0m \033[32mOK:\033[0m %s\n" "$*"
    return 0
  fi
  echo "[local-edge] OK: $*"
}

local_edge_warn() {
  if local_edge_log_color_enabled; then
    printf "\033[1;33m[local-edge]\033[0m \033[33mWARNING:\033[0m %s\n" "$*" >&2
    return 0
  fi
  echo "[local-edge] WARNING: $*" >&2
}

local_edge_error() {
  if local_edge_log_color_enabled; then
    printf "\033[1;31m[local-edge]\033[0m \033[31mERROR:\033[0m %s\n" "$*" >&2
    return 0
  fi
  echo "[local-edge] ERROR: $*" >&2
}

local_edge_section() {
  local title="$1"
  if local_edge_is_truthy "${LOCAL_EDGE_LOG_FORMATTER_ACTIVE:-false}"; then
    echo "[local-edge:section] ${title}"
    return 0
  fi
  local divider="=============================================================================="
  local_edge_info "${divider}"
  local_edge_info "${title}"
  local_edge_info "${divider}"
}

local_edge_git_current_branch_or_detached() {
  local repo_path="$1"
  local branch_name=""

  branch_name="$(git -C "${repo_path}" branch --show-current 2>/dev/null || true)"
  if [[ -n "${branch_name}" ]]; then
    printf "%s\n" "${branch_name}"
    return 0
  fi

  branch_name="$(git -C "${repo_path}" rev-parse --short HEAD 2>/dev/null || true)"
  if [[ -n "${branch_name}" ]]; then
    printf "detached-%s\n" "${branch_name}"
    return 0
  fi

  printf "unknown\n"
}

local_edge_mkcert_trust_detected() {
  local caroot
  caroot="$(mkcert -CAROOT 2>/dev/null || true)"
  if [[ -z "${caroot}" ]]; then
    return 1
  fi

  if [[ ! -f "${caroot}/rootCA.pem" ]]; then
    return 1
  fi

  if ! command -v security >/dev/null 2>&1; then
    return 0
  fi

  if security find-certificate -a -c "mkcert development CA" "/Library/Keychains/System.keychain" >/dev/null 2>&1; then
    return 0
  fi

  if security find-certificate -a -c "mkcert development CA" "${HOME}/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

local_edge_loopback_alias_exists() {
  local ip="$1"
  if [[ "${ip}" == "127.0.0.1" ]]; then
    return 0
  fi
  if ! command -v ifconfig >/dev/null 2>&1; then
    return 1
  fi
  if ifconfig lo0 2>/dev/null | grep -E -q "[[:space:]]inet[[:space:]]+${ip}([[:space:]]|$)"; then
    return 0
  fi
  return 1
}

local_edge_warn_or_fail() {
  local message="$1"
  local_edge_warn "${message}"
  if local_edge_should_fail_hard; then
    return 1
  fi
  return 0
}

local_edge_validate_port() {
  local label="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    local_edge_warn "${label} must be numeric. Current value='${value}'."
    if local_edge_should_fail_hard; then
      return 1
    fi
    return 0
  fi
  if (( value < 1 || value > 65535 )); then
    local_edge_warn "${label} must be in range 1..65535. Current value='${value}'."
    if local_edge_should_fail_hard; then
      return 1
    fi
  fi
}

local_edge_validate_positive_integer() {
  local label="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    local_edge_warn "${label} must be numeric. Current value='${value}'."
    if local_edge_should_fail_hard; then
      return 1
    fi
    return 0
  fi
  if (( value < 1 )); then
    local_edge_warn "${label} must be >= 1. Current value='${value}'."
    if local_edge_should_fail_hard; then
      return 1
    fi
  fi
}

local_edge_require_file_path() {
  local file_path="$1"
  local description="$2"
  if [[ -f "${file_path}" ]]; then
    return 0
  fi
  local_edge_warn_or_fail "Missing file (${description}): ${file_path}" || return 1
  return 0
}

local_edge_extract_command_bin() {
  local command="$1"
  local command_bin
  command_bin="$(echo "${command}" | sed -E 's/^[[:space:]]+//; s/[[:space:]].*$//')"
  command_bin="${command_bin//\"/}"
  command_bin="${command_bin//\'/}"
  echo "${command_bin}"
}

local_edge_command_exists() {
  local command_name="$1"
  if [[ -z "${command_name}" ]]; then
    return 1
  fi
  if command -v "${command_name}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

local_edge_is_macos() {
  [[ "$(uname -s 2>/dev/null)" == "Darwin" ]]
}

local_edge_docker_desktop_app_path() {
  if [[ -d "/Applications/Docker.app" ]]; then
    echo "/Applications/Docker.app"
    return 0
  fi
  if [[ -d "${HOME}/Applications/Docker.app" ]]; then
    echo "${HOME}/Applications/Docker.app"
    return 0
  fi
  return 1
}

local_edge_docker_daemon_ready() {
  if ! local_edge_command_exists "docker"; then
    return 1
  fi
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

local_edge_try_start_docker_desktop() {
  if ! local_edge_is_macos; then
    return 0
  fi
  if ! local_edge_is_truthy "${LOCAL_EDGE_DOCKER_AUTO_LAUNCH:-true}"; then
    return 0
  fi
  if ! command -v open >/dev/null 2>&1; then
    return 0
  fi

  local app_path
  app_path="$(local_edge_docker_desktop_app_path || true)"
  if [[ -z "${app_path}" ]]; then
    return 0
  fi

  if pgrep -f "Docker Desktop|com.docker.backend|com.docker.supervisor" >/dev/null 2>&1; then
    return 0
  fi

  local_edge_info "Docker daemon not ready. Attempting to launch Docker Desktop..."
  open -g -a "${app_path}" >/dev/null 2>&1 || open -a "${app_path}" >/dev/null 2>&1 || true
}

local_edge_ensure_docker_ready_for_startup() {
  local timeout_seconds="${LOCAL_EDGE_DOCKER_WAIT_TIMEOUT_SECONDS:-120}"
  local interval_seconds="${LOCAL_EDGE_DOCKER_WAIT_INTERVAL_SECONDS:-2}"
  local elapsed_seconds=0

  local_edge_validate_positive_integer "LOCAL_EDGE_DOCKER_WAIT_TIMEOUT_SECONDS" "${timeout_seconds}" || return 1
  local_edge_validate_positive_integer "LOCAL_EDGE_DOCKER_WAIT_INTERVAL_SECONDS" "${interval_seconds}" || return 1

  if ! local_edge_command_exists "docker"; then
    local_edge_error "docker CLI is required for nginx-docker but was not found in PATH."
    local_edge_error "Install Docker Desktop and retry."
    return 1
  fi

  if local_edge_docker_daemon_ready; then
    return 0
  fi

  local_edge_try_start_docker_desktop
  local_edge_warn "Waiting for Docker daemon availability (timeout=${timeout_seconds}s, interval=${interval_seconds}s)..."
  while (( elapsed_seconds < timeout_seconds )); do
    if local_edge_docker_daemon_ready; then
      local_edge_info "Docker daemon is ready after ${elapsed_seconds}s."
      return 0
    fi
    sleep "${interval_seconds}"
    elapsed_seconds=$((elapsed_seconds + interval_seconds))
  done

  local_edge_error "Docker daemon is unavailable after ${timeout_seconds}s."
  if local_edge_is_macos; then
    local_edge_error "Start Docker Desktop and retry (example: open -a Docker)."
  else
    local_edge_error "Start Docker daemon/service and retry."
  fi
  return 1
}

local_edge_write_artifact() {
  local artifact_name="$1"
  local content="$2"
  local artifact_path="${LOCAL_EDGE_ARTIFACTS_DIR}/${artifact_name}"

  printf "%s\n" "${content}" >"${artifact_path}"

  if [[ ! -f "${artifact_path}" ]]; then
    local_edge_warn "Expected artifact missing after write: ${artifact_path}"
    if local_edge_should_fail_hard; then
      return 1
    fi
  fi
}

local_edge_run_start_command() {
  local method="$1"
  local command="$2"
  local log_file="${LOCAL_EDGE_LOG_DIR}/${method}.log"

  touch "${log_file}"
  if [[ ! -f "${log_file}" ]]; then
    local_edge_error "Unable to create log artifact: ${log_file}"
    return 1
  fi

  echo "[local-edge:${method}] Running start command. Logs: ${log_file}"
  local_edge_print_method_url_matrix "${method}"
  nohup bash -lc "${command}" >>"${log_file}" 2>&1 &
}

local_edge_run_stop_command() {
  local method="$1"
  local command="$2"
  local log_file="${LOCAL_EDGE_LOG_DIR}/${method}.log"

  touch "${log_file}"
  echo "[local-edge:${method}] Running stop command. Logs: ${log_file}"
  bash -lc "${command}" >>"${log_file}" 2>&1 || true
}

local_edge_terminate_processes_on_port_if_allowed() {
  local method="$1"
  local port="$2"
  local host="${3:-}"
  local allow_kill="${LOCAL_EDGE_ALLOW_PORT_KILL:-false}"

  if ! local_edge_is_truthy "${allow_kill}"; then
    return 0
  fi

  local pids
  if [[ -n "${host}" ]]; then
    pids="$(lsof -tiTCP@"${host}":"${port}" -sTCP:LISTEN || true)"
  else
    pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN || true)"
  fi
  if [[ -z "${pids}" ]]; then
    return 0
  fi

  local_edge_warn "Force stopping listeners on port ${port} for ${method}: ${pids}"
  kill ${pids} >/dev/null 2>&1 || true
}

local_edge_source_active_env_file_stack() {
  local env_file=""
  while IFS= read -r env_file; do
    if [[ -z "${env_file}" || ! -f "${env_file}" ]]; then
      continue
    fi
    # shellcheck disable=SC1090
    set -a
    source "${env_file}"
    set +a
    if local_edge_is_truthy "${LOCAL_EDGE_LOG_ENV_LOADS:-false}"; then
      local_edge_info "Loaded active env layer file: ${env_file}"
    fi
  done < <(local_edge_collect_active_env_source_files)
}

local_edge_method_required_utilities() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "docker"
      ;;
    *)
      ;;
  esac
}

local_edge_generated_dir() {
  local configured_dir="${LOCAL_EDGE_GENERATED_DIR:-${LOCAL_EDGE_GENERATED_DIR_DEFAULT}}"
  if [[ "$(basename "${configured_dir}")" == "generated" ]]; then
    printf "%s\n" "$(dirname "${configured_dir}")"
    return 0
  fi
  printf "%s\n" "${configured_dir}"
}

local_edge_is_supported_method() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

local_edge_slugify() {
  local raw_value="${1:-}"
  local normalized
  normalized="$(printf "%s" "${raw_value}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "${normalized}" ]]; then
    normalized="default"
  fi
  printf "%s\n" "${normalized}"
}

local_edge_resolved_developer_slug() {
  local raw_value="${LOCAL_EDGE_DEVELOPER_SLUG:-${USER:-dev}}"
  local_edge_slugify "${raw_value}"
}

local_edge_resolved_env_slug() {
  local raw_value="${LOCAL_EDGE_ENV_SLUG:-main}"
  local_edge_slugify "${raw_value}"
}

local_edge_nginx_docker_project_name() {
  local configured_name="${LOCAL_EDGE_NGINX_DOCKER_PROJECT_NAME:-}"
  if [[ -n "${configured_name}" ]]; then
    local_edge_slugify "${configured_name}"
    return 0
  fi

  local developer_slug
  local env_slug
  developer_slug="$(local_edge_resolved_developer_slug)"
  env_slug="$(local_edge_resolved_env_slug)"
  local_edge_slugify "local-edge-nginx-docker-${developer_slug}-${env_slug}"
}

local_edge_configured_methods() {
  local legacy_env_keys=""
  local methods_csv="${LOCAL_EDGE_METHODS:-nginx-docker}"
  local method
  local emitted_methods_csv=""
  local emitted_count=0

  legacy_env_keys="$(
    env | awk -F= '/^LOCAL_EDGE_.*MACOS/ { print $1 }' | sort | paste -sd',' -
  )"
  if [[ -n "${legacy_env_keys}" ]]; then
    local_edge_error "Unsupported legacy host-managed local-edge env keys detected. Remove: ${legacy_env_keys}."
    return 1
  fi

  for method in ${methods_csv//,/ }; do
    if ! local_edge_is_supported_method "${method}"; then
      continue
    fi

    if [[ ",${emitted_methods_csv}," == *",${method},"* ]]; then
      continue
    fi

    if [[ -z "${emitted_methods_csv}" ]]; then
      emitted_methods_csv="${method}"
    else
      emitted_methods_csv="${emitted_methods_csv},${method}"
    fi
    emitted_count=$((emitted_count + 1))
  done

  if [[ "${emitted_count}" -eq 0 ]]; then
    emitted_methods_csv="nginx-docker"
    emitted_count=1
  fi

  if [[ "${emitted_count}" -ne 1 ]]; then
    local_edge_error "LOCAL_EDGE_METHODS must contain exactly one method in single-method mode. Current value='${methods_csv}'."
    return 1
  fi

  printf "%s\n" "${emitted_methods_csv}"
}

local_edge_method_is_configured() {
  local target_method="$1"
  local configured_method
  while IFS= read -r configured_method; do
    if [[ "${configured_method}" == "${target_method}" ]]; then
      return 0
    fi
  done < <(local_edge_configured_methods)
  return 1
}

local_edge_primary_method() {
  local configured_primary="${LOCAL_EDGE_PRIMARY_METHOD:-nginx-docker}"
  local methods_csv=""

  if [[ -z "${configured_primary}" ]]; then
    local_edge_error "LOCAL_EDGE_PRIMARY_METHOD is required and cannot be empty."
    return 1
  fi

  if ! local_edge_is_supported_method "${configured_primary}"; then
    local_edge_error "LOCAL_EDGE_PRIMARY_METHOD='${configured_primary}' is unsupported. Allowed value: nginx-docker."
    return 1
  fi

  methods_csv="$(local_edge_configured_methods | paste -sd',' -)" || return 1
  if [[ -z "${methods_csv}" ]]; then
    local_edge_error "LOCAL_EDGE_METHODS must resolve to a single supported method."
    return 1
  fi

  if [[ ",${methods_csv}," == *",${configured_primary},"* ]]; then
    echo "${configured_primary}"
    return 0
  fi

  local_edge_error "LOCAL_EDGE_PRIMARY_METHOD='${configured_primary}' is not present in LOCAL_EDGE_METHODS='${methods_csv}'."
  return 1
}

local_edge_method_port() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "${LOCAL_EDGE_NGINX_DOCKER_PORT:-443}"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_listen_host() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "${LOCAL_EDGE_NGINX_DOCKER_HOST:-127.0.0.1}"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_split_dns_ip() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "${LOCAL_EDGE_SPLIT_DNS_NGINX_DOCKER_IP:-${LOCAL_EDGE_NGINX_DOCKER_HOST:-127.0.0.1}}"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_format_https_url() {
  local host="$1"
  local port="$2"
  local request_path="$3"
  if [[ "${port}" == "443" ]]; then
    echo "https://${host}${request_path}"
    return 0
  fi
  echo "https://${host}:${port}${request_path}"
}

local_edge_router_probe_path() {
  printf "%s\n" "/__local-edge/router-health"
}

local_edge_router_probe_realm() {
  local explicit_realm="${1:-}"
  if [[ -n "${explicit_realm}" ]]; then
    printf "%s\n" "${explicit_realm}"
    return 0
  fi
  printf "%s\n" "$(local_edge_resolved_env_slug)"
}

local_edge_router_probe_url() {
  local method="$1"
  local realm_slug="${2:-}"
  local surface="${3:-www}"
  local port=""
  local host=""
  local request_path="/"

  port="$(local_edge_method_port "${method}")"
  host="$(local_edge_surface_hostname "${surface}" "${method}" "${realm_slug}")"
  request_path="$(local_edge_router_probe_path)"
  local_edge_format_https_url "${host}" "${port}" "${request_path}"
}

local_edge_router_host_probe() {
  local method="$1"
  local realm_slug="${2:-}"
  local probe_url=""
  local http_code=""

  local_edge_require_utility "curl" || return 1

  probe_url="$(local_edge_router_probe_url "${method}" "${realm_slug}" "www")"
  http_code="$(
    curl -k -sS -o /dev/null \
      --connect-timeout "${LOCAL_EDGE_ROUTER_PROBE_CONNECT_TIMEOUT_SECONDS:-3}" \
      --max-time "${LOCAL_EDGE_ROUTER_PROBE_MAX_TIME_SECONDS:-6}" \
      -w '%{http_code}' \
      "${probe_url}" 2>/dev/null || true
  )"

  if [[ "${http_code}" =~ ^[0-9]{3}$ && "${http_code}" != "000" ]]; then
    return 0
  fi

  return 1
}

local_edge_method_port_var_name() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "LOCAL_EDGE_NGINX_DOCKER_PORT"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_host_var_name() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "LOCAL_EDGE_NGINX_DOCKER_HOST"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_tls_cert_path() {
  local configured_path="${LOCAL_EDGE_TLS_CERT_PATH:-}"
  if [[ -n "${configured_path}" ]]; then
    local_edge_normalize_legacy_artifact_path "${configured_path}"
    return 0
  fi
  echo "$(local_edge_generated_dir)/certs/local-edge-cert.pem"
}

local_edge_tls_key_path() {
  local configured_path="${LOCAL_EDGE_TLS_KEY_PATH:-}"
  if [[ -n "${configured_path}" ]]; then
    local_edge_normalize_legacy_artifact_path "${configured_path}"
    return 0
  fi
  echo "$(local_edge_generated_dir)/certs/local-edge-key.pem"
}

local_edge_method_default_config_path() {
  local method="$1"
  local generated_dir
  generated_dir="$(local_edge_generated_dir)"
  case "${method}" in
    nginx-docker)
      echo "${generated_dir}/router/nginx-docker/docker-compose.yml"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_nginx_docker_nginx_config_path() {
  local configured_path="${LOCAL_EDGE_NGINX_DOCKER_NGINX_CONFIG_PATH:-}"
  if [[ -n "${configured_path}" ]]; then
    local_edge_normalize_legacy_artifact_path "${configured_path}"
    return 0
  fi
  echo "$(local_edge_generated_dir)/router/nginx-docker/nginx.conf"
}

local_edge_method_effective_config_path() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      if [[ -n "${LOCAL_EDGE_NGINX_DOCKER_CONFIG_PATH:-}" ]]; then
        local_edge_normalize_legacy_artifact_path "${LOCAL_EDGE_NGINX_DOCKER_CONFIG_PATH}"
        return 0
      fi
      echo "$(local_edge_method_default_config_path "${method}")"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_start_cmd() {
  local method="$1"
  local config_path
  config_path="$(local_edge_method_effective_config_path "${method}")"
  case "${method}" in
    nginx-docker)
      echo "${LOCAL_EDGE_NGINX_DOCKER_START_CMD:-docker compose -p \"$(local_edge_nginx_docker_project_name)\" -f \"${config_path}\" up -d}"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_stop_cmd() {
  local method="$1"
  local config_path
  config_path="$(local_edge_method_effective_config_path "${method}")"
  case "${method}" in
    nginx-docker)
      echo "${LOCAL_EDGE_NGINX_DOCKER_STOP_CMD:-docker compose -p \"$(local_edge_nginx_docker_project_name)\" -f \"${config_path}\" down}"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_method_required_artifact_paths() {
  local method="$1"
  case "${method}" in
    nginx-docker)
      echo "$(local_edge_method_effective_config_path "${method}")"
      echo "$(local_edge_nginx_docker_nginx_config_path)"
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}

local_edge_validate_method_setup() {
  local method="$1"
  local port
  local listen_host
  local start_cmd
  local port_env_var_name
  local host_env_var_name
  local command_bin
  local artifact_path

  local_edge_require_utility "bash"
  local_edge_require_utility "lsof"
  local_edge_require_utility "nohup"

  for util in $(local_edge_method_required_utilities "${method}"); do
    local_edge_require_utility "${util}" || return 1
  done

  if [[ "${method}" == "nginx-docker" ]]; then
    local_edge_ensure_docker_ready_for_startup || return 1
  fi

  port="$(local_edge_method_port "${method}")"
  listen_host="$(local_edge_method_listen_host "${method}")"
  port_env_var_name="$(local_edge_method_port_var_name "${method}")"
  host_env_var_name="$(local_edge_method_host_var_name "${method}")"
  local_edge_validate_port "${port_env_var_name}" "${port}" || return 1
  if [[ -z "${listen_host}" ]]; then
    local_edge_warn_or_fail "${host_env_var_name} must be configured with a non-empty value." || return 1
  fi

  start_cmd="$(local_edge_method_start_cmd "${method}")"
  command_bin="$(local_edge_extract_command_bin "${start_cmd}")"
  if [[ -n "${command_bin}" ]]; then
    local_edge_require_utility "${command_bin}" || return 1
  fi

  while IFS= read -r artifact_path; do
    if [[ -n "${artifact_path}" ]]; then
      local_edge_require_file_path "${artifact_path}" "required runtime artifact for ${method}" || return 1
    fi
  done < <(local_edge_method_required_artifact_paths "${method}")

  local_edge_require_file_path "$(local_edge_tls_cert_path)" "TLS certificate for ${method}" || return 1
  local_edge_require_file_path "$(local_edge_tls_key_path)" "TLS private key for ${method}" || return 1
}

local_edge_is_port_listening() {
  local port="$1"
  local host="${2:-}"

  local netstat_pattern=""
  local host_escaped=""
  local netstat_output=""
  if [[ -n "${host}" ]]; then
    host_escaped="${host//./\\.}"
    netstat_pattern="${host_escaped}\\.${port}[[:space:]].*LISTEN"
  else
    netstat_pattern="\\.${port}[[:space:]].*LISTEN"
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat_output="$(netstat -anv -p tcp 2>/dev/null || true)"
  fi

  if [[ -n "${host}" ]]; then
    if lsof -nP -iTCP@"${host}":"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "${netstat_output}" ]]; then
      if grep -E -q "${netstat_pattern}" <<<"${netstat_output}"; then
        return 0
      fi
    fi
    return 1
  fi
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  if [[ -n "${netstat_output}" ]]; then
    if grep -E -q "${netstat_pattern}" <<<"${netstat_output}"; then
      return 0
    fi
  fi
  return 1
}


local_edge_wait_for_port() {
  local port="$1"
  local timeout_seconds="$2"
  local host="${3:-}"
  local waited=0

  while [[ "${waited}" -lt "${timeout_seconds}" ]]; do
    if local_edge_is_port_listening "${port}" "${host}"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}


local_edge_wait_for_port_closed() {
  local port="$1"
  local timeout_seconds="$2"
  local host="${3:-}"
  local waited=0

  while [[ "${waited}" -lt "${timeout_seconds}" ]]; do
    if ! local_edge_is_port_listening "${port}" "${host}"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}


local_edge_nginx_docker_container_running() {
  local project_name
  local config_path
  local container_id=""

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  project_name="$(local_edge_nginx_docker_project_name)"
  config_path="$(local_edge_method_effective_config_path "nginx-docker")"
  container_id="$(docker compose -p "${project_name}" -f "${config_path}" ps -q local-edge-nginx-docker 2>/dev/null | head -n 1 || true)"
  if [[ -z "${container_id}" ]]; then
    return 1
  fi

  if [[ "$(docker inspect -f '{{.State.Running}}' "${container_id}" 2>/dev/null || true)" == "true" ]]; then
    return 0
  fi
  return 1
}


local_edge_canonical_path() {
  local raw_path="${1:-}"
  if [[ -z "${raw_path}" ]]; then
    printf "%s\n" ""
    return 0
  fi

  if [[ ! -e "${raw_path}" ]]; then
    printf "%s\n" "${raw_path}"
    return 0
  fi

  (
    cd "$(dirname "${raw_path}")" >/dev/null 2>&1 &&
      printf "%s/%s\n" "$(pwd -P)" "$(basename "${raw_path}")"
  )
}


local_edge_nginx_docker_container_id() {
  local project_name
  local config_path
  local container_id=""

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  project_name="$(local_edge_nginx_docker_project_name)"
  config_path="$(local_edge_method_effective_config_path "nginx-docker")"
  container_id="$(docker compose -p "${project_name}" -f "${config_path}" ps -q local-edge-nginx-docker 2>/dev/null | head -n 1 || true)"
  if [[ -z "${container_id}" ]]; then
    return 1
  fi

  printf "%s\n" "${container_id}"
}


local_edge_nginx_docker_reload_current_container() {
  local container_id=""

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  container_id="$(local_edge_nginx_docker_container_id)" || return 1
  if [[ -z "${container_id}" ]]; then
    return 1
  fi

  if docker exec "${container_id}" nginx -s reload >/dev/null 2>&1; then
    return 0
  fi

  return 1
}


local_edge_docker_mount_source_for_destination() {
  local container_id="$1"
  local destination_path="$2"

  docker inspect -f '{{ range .Mounts }}{{ println .Source "|" .Destination }}{{ end }}' "${container_id}" 2>/dev/null |
    awk -F' \\| ' -v destination="${destination_path}" '$2 == destination { print $1; exit }'
}


local_edge_nginx_docker_runtime_matches_current_artifacts() {
  local container_id=""
  local actual_nginx_conf=""
  local actual_cert_path=""
  local actual_key_path=""
  local expected_nginx_conf=""
  local expected_cert_path=""
  local expected_key_path=""

  container_id="$(local_edge_nginx_docker_container_id)" || return 1

  actual_nginx_conf="$(local_edge_docker_mount_source_for_destination "${container_id}" "/etc/nginx/nginx.conf")"
  actual_cert_path="$(local_edge_docker_mount_source_for_destination "${container_id}" "/etc/nginx/certs/local-edge-cert.pem")"
  actual_key_path="$(local_edge_docker_mount_source_for_destination "${container_id}" "/etc/nginx/certs/local-edge-key.pem")"

  expected_nginx_conf="$(local_edge_canonical_path "$(local_edge_nginx_docker_nginx_config_path)")"
  expected_cert_path="$(local_edge_canonical_path "$(local_edge_tls_cert_path)")"
  expected_key_path="$(local_edge_canonical_path "$(local_edge_tls_key_path)")"

  actual_nginx_conf="$(local_edge_canonical_path "${actual_nginx_conf}")"
  actual_cert_path="$(local_edge_canonical_path "${actual_cert_path}")"
  actual_key_path="$(local_edge_canonical_path "${actual_key_path}")"

  if [[ "${actual_nginx_conf}" != "${expected_nginx_conf}" ]]; then
    return 1
  fi
  if [[ "${actual_cert_path}" != "${expected_cert_path}" ]]; then
    return 1
  fi
  if [[ "${actual_key_path}" != "${expected_key_path}" ]]; then
    return 1
  fi

  return 0
}


local_edge_method_runtime_is_running() {
  local method="$1"
  local port
  local host

  port="$(local_edge_method_port "${method}")"
  host="$(local_edge_method_listen_host "${method}")"

  case "${method}" in
    nginx-docker)
      if local_edge_nginx_docker_container_running && local_edge_is_port_listening "${port}" "${host}"; then
        return 0
      fi
      return 1
      ;;
    *)
      local_edge_error "Unsupported method '${method}'"
      return 1
      ;;
  esac
}


local_edge_wait_for_method_runtime() {
  local method="$1"
  local timeout_seconds="${2:-15}"
  local waited=0

  while [[ "${waited}" -lt "${timeout_seconds}" ]]; do
    if local_edge_method_runtime_is_running "${method}"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}


local_edge_wait_for_method_stopped() {
  local method="$1"
  local timeout_seconds="${2:-15}"
  local waited=0

  while [[ "${waited}" -lt "${timeout_seconds}" ]]; do
    if ! local_edge_method_runtime_is_running "${method}"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}


local_edge_should_fail_hard() {
  local strict="${LOCAL_EDGE_STRICT_START:-false}"
  if local_edge_is_truthy "${strict}"; then
    return 0
  fi
  return 1
}


local_edge_require_utility() {
  local utility="$1"
  if command -v "${utility}" >/dev/null 2>&1; then
    return 0
  fi
  local_edge_warn "Missing required utility: ${utility}"
  if local_edge_should_fail_hard; then
    return 1
  fi
  return 0
}


local_edge_has_interactive_terminal() {
  if [[ -t 0 && -t 1 ]]; then
    return 0
  fi
  return 1
}


local_edge_prompt_yes_no() {
  local prompt="$1"
  local default_answer="${2:-y}"
  local reply=""

  if ! local_edge_has_interactive_terminal; then
    return 1
  fi

  while true; do
    if [[ "${default_answer}" == "y" ]]; then
      read -r -p "${prompt} [Y/n] " reply
      reply="${reply:-y}"
    else
      read -r -p "${prompt} [y/N] " reply
      reply="${reply:-n}"
    fi

    case "${reply}" in
      y|Y|yes|YES)
        return 0
        ;;
      n|N|no|NO)
        return 1
        ;;
      *)
        local_edge_warn "Please answer 'y' or 'n'."
        ;;
    esac
  done
}


local_edge_prompt_install_homebrew_formula() {
  local formula="$1"
  local purpose="$2"

  if ! local_edge_has_interactive_terminal; then
    local_edge_error "Interactive terminal required to install '${formula}'. Install it manually and re-run."
    return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    local_edge_error "Homebrew is required to install '${formula}'. Install Homebrew or install '${formula}' manually."
    return 1
  fi

  local_edge_warn "Missing required utility '${formula}' for ${purpose}."
  if ! local_edge_prompt_yes_no "Install '${formula}' via Homebrew now?" "y"; then
    local_edge_error "Required utility '${formula}' was not installed."
    return 1
  fi

  local_edge_info "Installing Homebrew formula '${formula}'..."
  brew install "${formula}"
}
