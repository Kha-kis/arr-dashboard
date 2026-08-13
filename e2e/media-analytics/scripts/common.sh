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
  docker ps -aq --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}"
  docker network ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}"
  docker volume ls -q --filter "label=${COMPOSE_PROJECT_LABEL}=${COMPOSE_PROJECT}"
}

assert_owned_resources() {
  local resource_id label resource_ids

  if ! resource_ids="$(owned_resource_ids)"; then
    echo "refusing to mutate: unable to list compose resources" >&2
    return 1
  fi

  while IFS= read -r resource_id || [[ -n "$resource_id" ]]; do
    [[ -z "$resource_id" ]] && continue

    if ! label="$(docker inspect --format '{{if .Config}}{{index .Config.Labels "com.docker.compose.project"}}{{else}}{{index .Labels "com.docker.compose.project"}}{{end}}' "$resource_id")"; then
      echo "refusing to mutate resource $resource_id: unable to inspect ownership" >&2
      return 1
    fi

    if [[ "$label" != "$COMPOSE_PROJECT" ]]; then
      echo "refusing to mutate resource $resource_id: compose project label does not match" >&2
      return 1
    fi
  done <<< "$resource_ids"
}
