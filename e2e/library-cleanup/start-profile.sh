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
	sqlite)
		compose_profile=candidate-sqlite
		service=dashboard-sqlite
		no_build=1
		;;
	postgres)
		compose_profile=candidate-postgres
		service=dashboard-postgres
		no_build=1
		;;
	baseline)
		compose_profile=baseline
		service=dashboard-baseline
		no_build=0
		;;
	*)
		echo "Harness start refused: profile must be sqlite, postgres, or baseline." >&2
		exit 2
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"
acquire_live_project_lock
verify_live_project --allow-empty

if [ "$no_build" -eq 1 ]; then
	compose --profile "$compose_profile" up --no-build --wait "$service"
else
	compose --profile "$compose_profile" up --wait "$service"
fi
verify_live_project
