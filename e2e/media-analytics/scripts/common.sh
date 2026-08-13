#!/usr/bin/env bash

set -euo pipefail

readonly HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly COMPOSE_PROJECT="arr-dashboard-media-analytics-e2e"
readonly COMPOSE_FILE="${HARNESS_DIR}/docker-compose.yml"
readonly COMPOSE_PROJECT_LABEL="com.docker.compose.project"

compose() {
  docker compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" "$@"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command is not available: $1" >&2
    return 1
  fi
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
        resource_ids="$(docker ps -aq --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"
        ;;
      network)
        resource_ids="$(docker network ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"
        ;;
      volume)
        resource_ids="$(docker volume ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}")"
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
