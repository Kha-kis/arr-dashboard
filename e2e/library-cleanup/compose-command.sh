#!/bin/sh

: "${SCRIPT_DIR:?compose-command.sh requires SCRIPT_DIR}"
: "${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}"

is_compose_v2() {
	compose_version=$("$@" version --short 2>/dev/null) || return 1
	compose_version=${compose_version#v}
	compose_major=${compose_version%%.*}
	case "$compose_major" in
		'' | *[!0-9]*) return 1 ;;
		*) [ "$compose_major" -ge 2 ] ;;
	esac
}

resolve_compose_command() {
	if [ -n "${ARR_COMPOSE_BIN:-}" ]; then
		if [ ! -x "$ARR_COMPOSE_BIN" ]; then
			echo "Library-cleanup harness refused: ARR_COMPOSE_BIN is not an executable: $ARR_COMPOSE_BIN." >&2
			exit 1
		fi
		if ! is_compose_v2 "$ARR_COMPOSE_BIN"; then
			echo "Library-cleanup harness refused: ARR_COMPOSE_BIN must provide Docker Compose v2 or newer." >&2
			exit 1
		fi
		COMPOSE_COMMAND=executable
		return
	fi

	if command -v docker-compose >/dev/null 2>&1 && is_compose_v2 docker-compose; then
		ARR_COMPOSE_BIN=$(command -v docker-compose)
		export ARR_COMPOSE_BIN
		COMPOSE_COMMAND=executable
		return
	fi

	for compose_plugin in \
		"${DOCKER_CONFIG:+$DOCKER_CONFIG/cli-plugins/docker-compose}" \
		"${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/docker/cli-plugins/docker-compose}" \
		"${HOME:+$HOME/.docker/cli-plugins/docker-compose}" \
		"${HOME:+$HOME/.local/lib/docker/cli-plugins/docker-compose}" \
		/usr/local/lib/docker/cli-plugins/docker-compose \
		/usr/local/libexec/docker/cli-plugins/docker-compose \
		/usr/lib/docker/cli-plugins/docker-compose \
		/usr/libexec/docker/cli-plugins/docker-compose; do
		if [ -n "$compose_plugin" ] && [ -x "$compose_plugin" ] && is_compose_v2 "$compose_plugin"; then
			ARR_COMPOSE_BIN=$compose_plugin
			export ARR_COMPOSE_BIN
			COMPOSE_COMMAND=executable
			return
		fi
	done

	if command -v docker >/dev/null 2>&1 && is_compose_v2 docker compose; then
		COMPOSE_COMMAND=docker
		return
	fi

	echo "Library-cleanup harness refused: Docker Compose v2 was not found. Set ARR_COMPOSE_BIN to an executable." >&2
	exit 1
}

resolve_compose_command

resolve_compose_command_vector() {
	case "$COMPOSE_COMMAND" in
		docker)
			ARR_RESOLVED_COMPOSE_EXECUTABLE=docker
			ARR_RESOLVED_COMPOSE_ARGUMENT=compose
			;;
		executable)
			ARR_RESOLVED_COMPOSE_EXECUTABLE=$ARR_COMPOSE_BIN
			ARR_RESOLVED_COMPOSE_ARGUMENT=
			;;
		*)
			echo "Library-cleanup harness refused: invalid Compose command selection." >&2
			exit 1
			;;
	esac
}

resolve_compose_command_vector

run_compose() {
	case "$COMPOSE_COMMAND" in
		docker) docker compose "$@" ;;
		executable) "$ARR_COMPOSE_BIN" "$@" ;;
		*)
			echo "Library-cleanup harness refused: invalid Compose command selection." >&2
			exit 1
			;;
	esac
}

compose_base() {
	run_compose -p "$COMPOSE_PROJECT_NAME" -f "$SCRIPT_DIR/compose.yml" "$@"
}

compose() {
	compose_base -f "$SCRIPT_DIR/compose.debug.yml" "$@"
}
