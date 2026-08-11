#!/bin/sh

: "${SCRIPT_DIR:?compose-command.sh requires SCRIPT_DIR}"
: "${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}"

ARR_COMPOSE_BIN=${ARR_COMPOSE_BIN:-/home/khak1s/.docker/cli-plugins/docker-compose}
export ARR_COMPOSE_BIN

if [ ! -x "$ARR_COMPOSE_BIN" ]; then
	echo "Library-cleanup harness refused: Compose binary is not executable at $ARR_COMPOSE_BIN." >&2
	exit 1
fi

compose_base() {
	"$ARR_COMPOSE_BIN" -p "$COMPOSE_PROJECT_NAME" -f "$SCRIPT_DIR/compose.yml" "$@"
}

compose() {
	compose_base -f "$SCRIPT_DIR/compose.debug.yml" "$@"
}
