#!/usr/bin/env bash

set -euo pipefail

readonly HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly COMPOSE_PROJECT="arr-dashboard-media-analytics-e2e"
readonly COMPOSE_FILE="${HARNESS_DIR}/docker-compose.yml"
readonly COMPOSE_PROJECT_LABEL="com.docker.compose.project"
readonly HARNESS_ENV_FILE="${HARNESS_DIR}/.env"

load_harness_ports() {
  local key value

  if [[ -f "$HARNESS_ENV_FILE" ]]; then
    while IFS='=' read -r key value || [[ -n "$key" || -n "$value" ]]; do
      key="${key%$'\r'}"
      value="${value%$'\r'}"
      [[ -z "$key" || "$key" == \#* ]] && continue
      case "$key" in
        PLEX_PORT|TAUTULLI_PORT|TRACEARR_PORT|DASHBOARD_PORT|DASHBOARD_API_PORT)
          if [[ -z "${!key+x}" ]]; then
            export "$key=$value"
          fi
          ;;
      esac
    done < "$HARNESS_ENV_FILE"
  fi

  : "${PLEX_PORT:=32400}" "${TAUTULLI_PORT:=38181}" "${TRACEARR_PORT:=33000}"
  : "${DASHBOARD_PORT:=33030}" "${DASHBOARD_API_PORT:=33031}"
  export PLEX_PORT TAUTULLI_PORT TRACEARR_PORT DASHBOARD_PORT DASHBOARD_API_PORT

  for key in PLEX_PORT TAUTULLI_PORT TRACEARR_PORT DASHBOARD_PORT DASHBOARD_API_PORT; do
    value="${!key}"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
      echo "$key must be a numeric TCP port between 1 and 65535" >&2
      return 1
    fi
  done
}

load_harness_ports

compose() {
  local compose_args=(compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE")
  if [[ -f "$HARNESS_ENV_FILE" ]]; then
    compose_args=(compose --project-name "$COMPOSE_PROJECT" --env-file "$HARNESS_ENV_FILE" --file "$COMPOSE_FILE")
  fi
  docker "${compose_args[@]}" "$@"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command is not available: $1" >&2
    return 1
  fi
}

acquire_lifecycle_lock() {
  local daemon_id inherited_fd lock_dir lock_file open_target

  require_command flock
  if ! daemon_id="$(docker info --format '{{.ID}}')" || [[ ! "$daemon_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "unable to resolve a safe Docker engine identity for the media analytics lifecycle lock" >&2
    return 1
  fi
  # The lock path deliberately ignores XDG_RUNTIME_DIR and other caller-specific
  # environment so every worktree targeting this Docker engine contends on the
  # same per-project, per-uid lock.
  lock_dir="/tmp/${COMPOSE_PROJECT}-$(id -u)-${daemon_id}"
  lock_file="${lock_dir}/lifecycle.lock"

  if [[ -L "$lock_dir" ]]; then
    echo "refusing unsafe media analytics lifecycle lock directory" >&2
    return 1
  fi
  if ! mkdir -m 0700 "$lock_dir" 2>/dev/null && [[ ! -d "$lock_dir" ]]; then
    echo "unable to create media analytics lifecycle lock directory" >&2
    return 1
  fi
  if [[ "$(stat -c '%u' "$lock_dir")" != "$(id -u)" || "$(stat -c '%a' "$lock_dir")" != "700" ]]; then
    echo "refusing unsafe media analytics lifecycle lock directory" >&2
    return 1
  fi

  inherited_fd="${MEDIA_ANALYTICS_LIFECYCLE_LOCK_FD:-}"
  if [[ -n "$inherited_fd" ]]; then
    if [[ "$inherited_fd" != "9" || ! -e "/proc/$$/fd/${inherited_fd}" ]]; then
      echo "refusing invalid inherited media analytics lifecycle lock" >&2
      return 1
    fi
    open_target="$(readlink "/proc/$$/fd/${inherited_fd}")"
    if [[ "$open_target" != "$lock_file" ]]; then
      echo "refusing mismatched inherited media analytics lifecycle lock" >&2
      return 1
    fi
    return 0
  fi

  if [[ -L "$lock_file" ]]; then
    echo "refusing unsafe media analytics lifecycle lock file" >&2
    return 1
  fi
  exec 9>"$lock_file"
  chmod 0600 "$lock_file"
  if ! flock -n 9; then
    echo "media analytics lifecycle operation is already running" >&2
    return 1
  fi
  export MEDIA_ANALYTICS_LIFECYCLE_LOCK_FD=9
}

assert_loopback_url() {
  local url="$1"

  if [[ ! "$url" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
    echo "refusing non-loopback URL: $url" >&2
    return 1
  fi
}

owned_resource_ids() {
  local resource_id resource_ids resource_type

  for resource_type in container network volume; do
    case "$resource_type" in
      container)
        if ! resource_ids="$(docker ps -aq --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"; then
          return 1
        fi
        ;;
      network)
        if ! resource_ids="$(docker network ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"; then
          return 1
        fi
        ;;
      volume)
        if ! resource_ids="$(docker volume ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"; then
          return 1
        fi
        ;;
    esac

    while IFS= read -r resource_id || [[ -n "$resource_id" ]]; do
      [[ -z "$resource_id" ]] && continue
      printf '%s\t%s\n' "$resource_type" "$resource_id"
    done <<< "$resource_ids"
  done
}

assert_owned_resources() {
  local label resource_id resource_ids resource_type

  if ! resource_ids="$(owned_resource_ids)"; then
    echo "refusing to mutate: unable to list compose resources" >&2
    return 1
  fi

  while IFS=$'\t' read -r resource_type resource_id || [[ -n "$resource_type" || -n "$resource_id" ]]; do
    if [[ -z "$resource_type" || -z "$resource_id" ]]; then
      echo "refusing to mutate: malformed compose resource record" >&2
      return 1
    fi

    case "$resource_type" in
      container)
        if ! label="$(docker container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$resource_id")"; then
          echo "refusing to mutate resource $resource_id: unable to inspect ownership" >&2
          return 1
        fi
        ;;
      network)
        if ! label="$(docker network inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$resource_id")"; then
          echo "refusing to mutate resource $resource_id: unable to inspect ownership" >&2
          return 1
        fi
        ;;
      volume)
        if ! label="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$resource_id")"; then
          echo "refusing to mutate resource $resource_id: unable to inspect ownership" >&2
          return 1
        fi
        ;;
      *)
        echo "refusing to mutate resource $resource_id: unknown resource type $resource_type" >&2
        return 1
        ;;
    esac

    if [[ "$label" != "$COMPOSE_PROJECT" ]]; then
      echo "refusing to mutate resource $resource_id: compose project label does not match" >&2
      return 1
    fi
  done <<< "$resource_ids"
}
