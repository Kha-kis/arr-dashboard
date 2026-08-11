#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
RUNNER_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
RUNNER_SCRIPT=/tmp/lc-e2e-bootstrap-torrents-$PROJECT_NAME.mjs
if [ -z "${ARR_DOCKER_BIN:-}" ]; then
	DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
	export DOCKER_CONFIG
fi
. "$SCRIPT_DIR/compose-command.sh"
. "$SCRIPT_DIR/live-project-guard.sh"

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Torrent bootstrap refused: unsupported runner service $RUNNER_SERVICE." >&2
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

for service in qbittorrent-a qbittorrent-b "$RUNNER_SERVICE"; do
	if ! compose ps --status running --services | grep -Fxq "$service"; then
		echo "Torrent bootstrap refused: $service is not running in $PROJECT_NAME." >&2
		exit 1
	fi
done

temporary_password() {
	service=$1
	password=$(compose logs --no-color "$service" |
		sed -n 's/.*temporary password is provided for this session: //p' |
		tail -n 1)
	if [ -z "$password" ]; then
		echo "Torrent bootstrap could not find the disposable qBittorrent password for $service." >&2
		exit 1
	fi
	printf '%s' "$password"
}

QBITTORRENT_A_USERNAME=admin
QBITTORRENT_B_USERNAME=admin
QBITTORRENT_A_PASSWORD=$(temporary_password qbittorrent-a)
QBITTORRENT_B_PASSWORD=$(temporary_password qbittorrent-b)
export QBITTORRENT_A_USERNAME QBITTORRENT_A_PASSWORD
export QBITTORRENT_B_USERNAME QBITTORRENT_B_PASSWORD

compose cp "$SCRIPT_DIR/bootstrap-torrents.mjs" "$RUNNER_SERVICE:$RUNNER_SCRIPT" >/dev/null
compose exec -T \
	-e QBITTORRENT_A_USERNAME \
	-e QBITTORRENT_A_PASSWORD \
	-e QBITTORRENT_B_USERNAME \
	-e QBITTORRENT_B_PASSWORD \
	"$RUNNER_SERVICE" node "$RUNNER_SCRIPT"

unset QBITTORRENT_A_USERNAME QBITTORRENT_A_PASSWORD
unset QBITTORRENT_B_USERNAME QBITTORRENT_B_PASSWORD

echo "Disposable qBittorrent fixtures are registered and verified."
