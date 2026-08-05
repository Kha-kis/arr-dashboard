#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
MODE=${1:?Specify policy, delete:<fixture>, or episode:<fixture>}
COMPOSE_BIN=${ARR_COMPOSE_BIN:-/home/khak1s/.docker/cli-plugins/docker-compose}
DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
RUNNER_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
RUNNER_SCRIPT=/tmp/lc-e2e-live-scenarios-$PROJECT_NAME.mjs
export DOCKER_CONFIG

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Unsupported disposable dashboard service: $RUNNER_SERVICE" >&2
		exit 1
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"

compose() {
	"$COMPOSE_BIN" -p "$PROJECT_NAME" -f compose.yml -f compose.debug.yml "$@"
}

cleanup() {
	compose exec -T --user 0 "$RUNNER_SERVICE" rm -f "$RUNNER_SCRIPT" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

extract_api_key() {
	service=$1
	key=$(compose exec -T "$service" sh -c \
		"sed -n 's:.*<ApiKey>\\([^<]*\\)</ApiKey>.*:\\1:p' /config/config.xml" |
		tail -n 1)
	if [ -z "$key" ]; then
		echo "Could not read the disposable API key from $service." >&2
		exit 1
	fi
	printf '%s' "$key"
}

for service in radarr-a radarr-b sonarr-a sonarr-b plex plex-loopback-proxy qui-a qui-b "$RUNNER_SERVICE"; do
	if ! compose ps --status running --services | grep -Fxq "$service"; then
		echo "Live scenario refused: $service is not running in $PROJECT_NAME." >&2
		exit 1
	fi
done

radarr_a_key=$(extract_api_key radarr-a)
radarr_b_key=$(extract_api_key radarr-b)
sonarr_a_key=$(extract_api_key sonarr-a)
sonarr_b_key=$(extract_api_key sonarr-b)

compose cp "$SCRIPT_DIR/live-scenarios.mjs" "$RUNNER_SERVICE:$RUNNER_SCRIPT" >/dev/null
compose exec -T \
	-e RADARR_A_KEY="$radarr_a_key" \
	-e RADARR_B_KEY="$radarr_b_key" \
	-e SONARR_A_KEY="$sonarr_a_key" \
	-e SONARR_B_KEY="$sonarr_b_key" \
	"$RUNNER_SERVICE" node "$RUNNER_SCRIPT" "$MODE"
