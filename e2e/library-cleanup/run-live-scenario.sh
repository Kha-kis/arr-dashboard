#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
if [ -z "${ARR_DOCKER_BIN:-}" ]; then
	DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
	export DOCKER_CONFIG
fi
. "$SCRIPT_DIR/compose-command.sh"
. "$SCRIPT_DIR/live-project-guard.sh"
MODE=${1:?Specify policy, delete:<fixture>, or episode:<fixture>}
RUNNER_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
RUNNER_SCRIPT=/tmp/lc-e2e-live-scenarios-$PROJECT_NAME.mjs
DOCKER_BIN=${ARR_DOCKER_BIN:-docker}

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Unsupported disposable dashboard service: $RUNNER_SERVICE" >&2
		exit 1
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"
acquire_live_project_lock
verify_live_project

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

case "$MODE" in
	policy | policy-gate)
		container_id=$(compose ps -q "$RUNNER_SERVICE")
		if [ -z "$container_id" ]; then
			echo "Policy gate refused: could not identify $RUNNER_SERVICE before restart." >&2
			exit 1
		fi
		compose restart "$RUNNER_SERVICE"
		compose up --no-build --wait "$RUNNER_SERVICE"
		verify_live_project
		restarted_container_id=$(compose ps -q "$RUNNER_SERVICE")
		if [ "$restarted_container_id" != "$container_id" ]; then
			echo "Policy gate refused: $RUNNER_SERVICE container identity changed during restart." >&2
			exit 1
		fi
		container_project=$("$DOCKER_BIN" inspect "$restarted_container_id" \
			--format '{{index .Config.Labels "com.docker.compose.project"}}')
		container_service=$("$DOCKER_BIN" inspect "$restarted_container_id" \
			--format '{{index .Config.Labels "com.docker.compose.service"}}')
		if [ "$container_project" != "$PROJECT_NAME" ] || [ "$container_service" != "$RUNNER_SERVICE" ]; then
			echo "Policy gate refused a container outside $PROJECT_NAME/$RUNNER_SERVICE after restart." >&2
			exit 1
		fi
		sync_started=$("$DOCKER_BIN" inspect "$restarted_container_id" --format '{{.State.StartedAt}}')
		if [ -z "$sync_started" ] || [ "$sync_started" = "0001-01-01T00:00:00Z" ]; then
			echo "Policy gate refused: restarted $RUNNER_SERVICE has no precise StartedAt timestamp." >&2
			exit 1
		fi
		sync_complete=0
		for attempt in $(seq 1 30); do
			if compose logs --no-color --since "$sync_started" "$RUNNER_SERVICE" 2>&1 |
				grep -Fq '"msg":"qUI torrent-state sync completed"'; then
				sync_complete=1
				break
			fi
			sleep 2
		done
		if [ "$sync_complete" -ne 1 ]; then
			echo "Policy gate refused: qUI torrent-state sync did not complete after restart." >&2
			exit 1
		fi
		;;
esac

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
