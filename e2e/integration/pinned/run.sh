#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-e2e-pinned-$(date -u +%Y%m%d%H%M%S)-$$}
PINNED_E2E_RUN_TOKEN=$(openssl rand -hex 32)
export COMPOSE_PROJECT_NAME PINNED_E2E_RUN_TOKEN
case "$COMPOSE_PROJECT_NAME" in e2e-pinned-[a-z0-9-]*) ;; *) echo "unsafe project name" >&2; exit 2 ;; esac
case "$COMPOSE_PROJECT_NAME" in *prod*|*stable*|*candidate*) echo "reserved project name" >&2; exit 2 ;; esac
compose() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$HERE/compose.yml" "$@"; }
cleanup() { status=$?; trap - 0; if ! compose down --volumes --remove-orphans >/dev/null; then [ "$status" -ne 0 ] || status=1; fi; exit "$status"; }
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
"$HERE/verify-images.sh"
started=$(date +%s)
compose up -d --pull always --wait --wait-timeout 180
ready=$(date +%s)
jellyfin_version=$(compose exec -T jellyfin curl -fsS http://127.0.0.1:8096/System/Info/Public | python3 -c 'import json,sys; print(json.load(sys.stdin)["Version"])')
[ "$jellyfin_version" = 10.11.11 ] || { echo "Jellyfin version mismatch" >&2; exit 1; }
compose exec -T lidarr curl -fsS http://127.0.0.1:8686/ping >/dev/null
printf 'provider readiness passed; Jellyfin=%s; Lidarr=3.1.6.5079; elapsed_ms=%s\n' "$jellyfin_version" "$(( (ready-started)*1000 ))"
