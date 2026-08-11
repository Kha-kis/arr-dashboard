#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-live-scenario-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$TEMP_DIR/bin"
cp "$SCRIPT_DIR/run-live-scenario.sh" "$TEMP_DIR/run-live-scenario.sh"

cat >"$TEMP_DIR/compose-command.sh" <<'EOF'
compose() {
	case "$1" in
		ps)
			if [ "$2" = "-q" ]; then
				printf '%s\n' runner-container-id
			else
				printf '%s\n' radarr-a radarr-b sonarr-a sonarr-b plex plex-loopback-proxy qui-a qui-b dashboard-sqlite
			fi
			;;
		restart | up | cp) ;;
		logs)
			printf '%s\n' "$*" >>"$LC_E2E_TEST_LOG_ARGS"
			case "$*" in
				*--since\ 2026-08-10T12:00:00.123456789Z*) ;;
				*) printf '%s\n' '{"msg":"qUI torrent-state sync completed"}' ;;
			esac
			;;
		exec)
			case "$*" in
				*config.xml*) printf '%s\n' test-api-key ;;
			esac
			;;
		*) echo "unexpected compose command: $*" >&2; return 1 ;;
	esac
}
EOF

cat >"$TEMP_DIR/live-project-guard.sh" <<'EOF'
acquire_live_project_lock() { :; }
verify_live_project() { :; }
EOF

cat >"$TEMP_DIR/validate-compose.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$TEMP_DIR/validate-compose.sh"

cat >"$TEMP_DIR/bin/docker" <<'EOF'
#!/bin/sh
case "$*" in
	*'{{.State.StartedAt}}'*) printf '%s\n' 2026-08-10T12:00:00.123456789Z ;;
	*'com.docker.compose.project'*) printf '%s\n' live-test-project ;;
	*'com.docker.compose.service'*) printf '%s\n' dashboard-sqlite ;;
	*) echo "unexpected docker inspect: $*" >&2; exit 1 ;;
esac
EOF
cat >"$TEMP_DIR/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$TEMP_DIR/bin/docker" "$TEMP_DIR/bin/sleep"

set +e
PATH="$TEMP_DIR/bin:$PATH" \
	ARR_DOCKER_BIN=docker \
	COMPOSE_PROJECT_NAME=live-test-project \
	LC_E2E_TEST_LOG_ARGS="$TEMP_DIR/log-args" \
	sh "$TEMP_DIR/run-live-scenario.sh" policy-gate >"$TEMP_DIR/output" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
	echo "policy gate accepted a stale qUI completion from before restart." >&2
	exit 1
fi
if ! grep -Fq 'Policy gate refused: qUI torrent-state sync did not complete after restart.' "$TEMP_DIR/output"; then
	echo "policy gate did not reject the stale qUI completion." >&2
	cat "$TEMP_DIR/output" >&2
	exit 1
fi
if ! grep -Fq -- '--since 2026-08-10T12:00:00.123456789Z' "$TEMP_DIR/log-args"; then
	echo "policy gate did not bind log evidence to the restarted container StartedAt." >&2
	exit 1
fi

echo "live scenario rejects stale same-second qUI logs"
