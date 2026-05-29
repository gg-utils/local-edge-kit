#!/usr/bin/env bash

runtime_stop_array_contains() {
  local needle="${1:-}"
  shift || true

  local value=""
  for value in "$@"; do
    if [[ "${value}" == "${needle}" ]]; then
      return 0
    fi
  done

  return 1
}

runtime_stop_pid_is_alive() {
  local pid="${1:-}"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  kill -0 "${pid}" >/dev/null 2>&1
}

runtime_stop_resolve_pid_cwd() {
  local pid="${1:-}"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

runtime_stop_pid_has_checkout_cwd() {
  local pid="${1:-}"
  local project_root="${2:-}"
  local pid_cwd=""

  if [[ -z "${pid}" || -z "${project_root}" ]]; then
    return 1
  fi

  pid_cwd="$(runtime_stop_resolve_pid_cwd "${pid}" || true)"
  if [[ -z "${pid_cwd}" ]]; then
    return 1
  fi

  [[ "${pid_cwd}" == "${project_root}" || "${pid_cwd}" == "${project_root}/"* ]]
}

runtime_stop_collect_checkout_scoped_pids() {
  local project_root="${1:-}"
  shift || true

  if [[ -z "${project_root}" || "$#" -eq 0 ]]; then
    return 0
  fi

  local pattern=""
  local raw_pid=""
  local pid=""
  local -a matching_pids=()
  local matching_pid_count=0

  for pattern in "$@"; do
    while IFS= read -r raw_pid; do
      pid="$(printf "%s" "${raw_pid}" | tr -d '[:space:]')"
      if [[ -z "${pid}" ]]; then
        continue
      fi
      if [[ "${matching_pid_count}" -gt 0 ]] && runtime_stop_array_contains "${pid}" "${matching_pids[@]}"; then
        continue
      fi

      if runtime_stop_pid_has_checkout_cwd "${pid}" "${project_root}"; then
        matching_pids+=("${pid}")
        matching_pid_count=$((matching_pid_count + 1))
      fi
    done < <(pgrep -f "${pattern}" 2>/dev/null || true)
  done

  if [[ "${matching_pid_count}" -eq 0 ]]; then
    return 0
  fi

  for pid in "${matching_pids[@]}"; do
    printf "%s\n" "${pid}"
  done | sort -n
}

runtime_stop_wait_for_pids_exit() {
  local attempts="${1:-12}"
  shift || true

  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local sleep_seconds="0.25"
  local pid=""
  local -a pending_pids=("$@")
  local pending_pid_count="$#"

  while [[ "${attempts}" -gt 0 ]]; do
    local -a next_pending_pids=()
    local next_pending_pid_count=0
    for pid in "${pending_pids[@]}"; do
      if runtime_stop_pid_is_alive "${pid}"; then
        next_pending_pids+=("${pid}")
        next_pending_pid_count=$((next_pending_pid_count + 1))
      fi
    done

    if [[ "${next_pending_pid_count}" -eq 0 ]]; then
      return 0
    fi

    pending_pids=()
    if [[ "${next_pending_pid_count}" -gt 0 ]]; then
      pending_pids=("${next_pending_pids[@]}")
    fi
    pending_pid_count="${next_pending_pid_count}"
    sleep "${sleep_seconds}"
    attempts=$((attempts - 1))
  done

  return 1
}

runtime_stop_terminate_pid_list() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local pid=""
  local raw_arg=""
  local -a requested_pids=()
  local -a live_pids=()
  local -a remaining_pids=()
  local requested_pid_count=0
  local live_pid_count=0
  local remaining_pid_count=0

  echo "[runtime-stop] runtime_stop_terminate_pid_list called with $# arguments" >&2

  for raw_arg in "$@"; do
    while IFS= read -r pid; do
      pid="$(printf "%s" "${pid}" | tr -d '[:space:]')"
      if [[ -z "${pid}" ]]; then
        continue
      fi
      if [[ "${requested_pid_count}" -gt 0 ]] && runtime_stop_array_contains "${pid}" "${requested_pids[@]}"; then
        continue
      fi
      requested_pids+=("${pid}")
      requested_pid_count=$((requested_pid_count + 1))
    done <<< "${raw_arg}"
  done

  if [[ "${requested_pid_count}" -eq 0 ]]; then
    echo "[runtime-stop] No requested PIDs" >&2
    return 0
  fi

  echo "[runtime-stop] Requested PIDs: ${requested_pids[*]}" >&2

  for pid in "${requested_pids[@]}"; do
    if runtime_stop_pid_is_alive "${pid}"; then
      live_pids+=("${pid}")
      live_pid_count=$((live_pid_count + 1))
    fi
  done

  if [[ "${live_pid_count}" -eq 0 ]]; then
    echo "[runtime-stop] No live PIDs to terminate" >&2
    return 0
  fi

  echo "[runtime-stop] Live PIDs: ${live_pids[*]}, sending TERM" >&2
  kill -TERM "${live_pids[@]}" >/dev/null 2>&1 || true

  if runtime_stop_wait_for_pids_exit 12 "${live_pids[@]}"; then
    echo "[runtime-stop] All PIDs terminated gracefully" >&2
    return 0
  fi

  for pid in "${live_pids[@]}"; do
    if runtime_stop_pid_is_alive "${pid}"; then
      remaining_pids+=("${pid}")
      remaining_pid_count=$((remaining_pid_count + 1))
    fi
  done

  if [[ "${remaining_pid_count}" -eq 0 ]]; then
    echo "[runtime-stop] All PIDs terminated gracefully after wait" >&2
    return 0
  fi

  echo "[runtime-stop] Remaining PIDs after TERM: ${remaining_pids[*]}, sending KILL" >&2
  kill -KILL "${remaining_pids[@]}" >/dev/null 2>&1 || true
  runtime_stop_wait_for_pids_exit 4 "${remaining_pids[@]}" || true
}

runtime_stop_terminate_listeners_on_port() {
  local port="${1:-}"
  if [[ -z "${port}" ]]; then
    return 0
  fi

  local listener_pids=""
  listener_pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "${listener_pids}" ]]; then
    return 0
  fi

  runtime_stop_terminate_pid_list "${listener_pids}"
}
