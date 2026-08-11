#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
PROFILE=${1:?Specify sqlite, postgres, or baseline}
. "$SCRIPT_DIR/compose-command.sh"
. "$SCRIPT_DIR/live-project-guard.sh"

case "$PROFILE" in
	sqlite) service=dashboard-sqlite ;;
	postgres) service=dashboard-postgres ;;
	baseline) service=dashboard-baseline ;;
	*)
		echo "Harness stop refused: profile must be sqlite, postgres, or baseline." >&2
		exit 2
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"
acquire_live_project_lock
verify_live_project
compose stop "$service"
verify_live_project
