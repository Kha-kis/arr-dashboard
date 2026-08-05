#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
COMPOSE_BIN=${ARR_COMPOSE_BIN:-/home/khak1s/.docker/cli-plugins/docker-compose}
RUNNER_SERVICE=dashboard-sqlite
RUNNER_SCRIPT=/tmp/lc-e2e-bootstrap-plex-$PROJECT_NAME.mjs
DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
export DOCKER_CONFIG

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"

compose() {
	"$COMPOSE_BIN" -p "$PROJECT_NAME" -f compose.yml -f compose.debug.yml "$@"
}

cleanup() {
	compose exec -T --user 0 "$RUNNER_SERVICE" rm -f "$RUNNER_SCRIPT" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

for service in plex plex-loopback-proxy "$RUNNER_SERVICE"; do
	if ! compose ps --status running --services | grep -Fxq "$service"; then
		echo "Plex bootstrap refused: $service is not running in $PROJECT_NAME." >&2
		exit 1
	fi
done

compose cp "$SCRIPT_DIR/bootstrap-plex.mjs" "$RUNNER_SERVICE:$RUNNER_SCRIPT" >/dev/null
compose exec -T "$RUNNER_SERVICE" node "$RUNNER_SCRIPT"

echo "Disposable Plex libraries are configured and populated."
