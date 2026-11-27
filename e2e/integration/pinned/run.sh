#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# No caller-supplied project override: every run gets a fresh 96-bit name.
COMPOSE_PROJECT_NAME=e2e-pinned-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 12)
PINNED_E2E_RUN_TOKEN=$(openssl rand -hex 32)
export COMPOSE_PROJECT_NAME PINNED_E2E_RUN_TOKEN
compose() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$HERE/compose.yml" "$@"; }

assert_project_absent() {
  for kind in container volume network; do
    case "$kind" in
      container) ids=$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ;;
      volume) ids=$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ;;
      network) ids=$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ;;
    esac
    [ -z "$ids" ] || { echo "refusing pre-existing Compose project resources" >&2; return 1; }
  done
}

assert_owned_resources() {
  for kind in container volume network; do
    case "$kind" in
      container) ids=$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); format='{{ index .Config.Labels "io.arr-dashboard.e2e.pinned.project" }}:{{ index .Config.Labels "io.arr-dashboard.e2e.pinned.run-token" }}' ;;
      volume) ids=$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); format='{{ index .Labels "io.arr-dashboard.e2e.pinned.project" }}:{{ index .Labels "io.arr-dashboard.e2e.pinned.run-token" }}' ;;
      network) ids=$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); format='{{ index .Labels "io.arr-dashboard.e2e.pinned.project" }}:{{ index .Labels "io.arr-dashboard.e2e.pinned.run-token" }}' ;;
    esac
    for id in $ids; do
      identity=$(docker "$kind" inspect --format "$format" "$id")
      [ "$identity" = "$COMPOSE_PROJECT_NAME:$PINNED_E2E_RUN_TOKEN" ] || {
        echo "refusing cleanup because a project resource failed ownership verification" >&2
        return 1
      }
    done
  done
}

cleanup() {
  status=$?
  trap - 0
  if [ "$started_fixture" = 1 ]; then
    if assert_owned_resources; then
      if ! compose down --volumes --remove-orphans >/dev/null; then
        [ "$status" -ne 0 ] || status=1
        echo "cleanup failed for the verified disposable project" >&2
      fi
    else
      [ "$status" -ne 0 ] || status=1
      echo "fixture resources left untouched because ownership was uncertain" >&2
    fi
  fi
  exit "$status"
}
started_fixture=0
assert_project_absent
"$HERE/verify-images.sh"
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
started=$(date +%s)
started_fixture=1
compose up -d --pull always --wait --wait-timeout 180
ready=$(date +%s)
jellyfin_version=$(compose exec -T jellyfin curl -fsS http://127.0.0.1:8096/System/Info/Public | python3 -c 'import json,sys; print(json.load(sys.stdin)["Version"])')
[ "$jellyfin_version" = 10.11.11 ] || { echo "Jellyfin runtime version mismatch" >&2; exit 1; }
lidarr_version=$(compose exec -T lidarr sh -c 'set -eu; key=$(sed -n "s/.*<ApiKey>\\([^<]*\\)<\\/ApiKey>.*/\\1/p" /config/config.xml); [ -n "$key" ]; curl -fsS -H "X-Api-Key: $key" http://127.0.0.1:8686/api/v1/system/status' | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[ "$lidarr_version" = 3.1.6.5079 ] || { echo "Lidarr runtime version mismatch" >&2; exit 1; }
printf 'provider readiness passed; Jellyfin=%s; Lidarr=%s; elapsed_ms=%s\n' "$jellyfin_version" "$lidarr_version" "$(( (ready-started)*1000 ))"
