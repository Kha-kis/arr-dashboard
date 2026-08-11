#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-profile-ownership-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
HARNESS_DIR=$TEMP_DIR/harness
FAKE_BIN_DIR=$TEMP_DIR/bin
COMPOSE_LOG=$TEMP_DIR/compose.log
mkdir -p "$HARNESS_DIR" "$FAKE_BIN_DIR"

cp \
	"$SCRIPT_DIR/start-profile.sh" \
	"$SCRIPT_DIR/live-project-guard.sh" \
	"$SCRIPT_DIR/compose-command.sh" \
	"$SCRIPT_DIR/check-live-project.py" \
	"$HARNESS_DIR/"
cat >"$HARNESS_DIR/validate-compose.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$HARNESS_DIR/validate-compose.sh"

cat >"$FAKE_BIN_DIR/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$FAKE_BIN_DIR/fake-compose" <<'EOF'
#!/bin/sh
set -eu

if [ "$1" = version ] && [ "$2" = --short ]; then
	printf '%s\n' 2.40.0
	exit 0
fi

printf '%s\n' "$*" >>"$LC_E2E_TEST_COMPOSE_LOG"
case " $* " in
	*' config --format json '*)
		cat <<MODEL
{
  "services": {"app": {"image": "example:test", "volumes": [], "networks": {}}},
  "volumes": {"data": {"name": "${LC_E2E_TEST_PROJECT}_data"}},
  "networks": {"private": {"name": "${LC_E2E_TEST_PROJECT}_private"}}
}
MODEL
		;;
	*' config --hash='*) printf '%s\n' 'app hash' ;;
	*' ps --status running --services '*)
		case "${LC_E2E_TEST_PROFILE_MODE:?}" in
			pre-conflict) printf '%s\n' dashboard-postgres ;;
			post-conflict)
				if [ -f "${LC_E2E_TEST_UP_MARKER:?}" ]; then
					printf '%s\n' dashboard-postgres
				fi
				;;
		esac
		;;
	*' up '*) : >"${LC_E2E_TEST_UP_MARKER:?}" ;;
esac
EOF
cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/bin/sh
set -eu

kind=$1
command=$2
shift 2

is_post_up_run() {
	[ "${LC_E2E_TEST_PROFILE_MODE:-}" = post-conflict ] && [ -f "${LC_E2E_TEST_UP_MARKER:?}" ]
}

if [ "$command" = ls ]; then
		case " $* " in
			*' --format '*)
			case "${LC_E2E_TEST_COLLISION:-}:$kind" in
				container:container)
					case " $* " in *' -a '*) printf '%s\n' "${LC_E2E_TEST_PROJECT}-app-1" ;; esac
				;;
				volume:volume) printf '%s\n' "${LC_E2E_TEST_PROJECT}_data" ;;
				network:network) printf '%s\n' "${LC_E2E_TEST_PROJECT}_private" ;;
				*)
					if is_post_up_run; then
						case "$kind" in
							volume) printf '%s\n' "${LC_E2E_TEST_PROJECT}_data" ;;
							network) printf '%s\n' "${LC_E2E_TEST_PROJECT}_private" ;;
						esac
					fi
					;;
			esac
			;;
	esac
	exit 0
fi

	if [ "$command" = inspect ]; then
		case "${LC_E2E_TEST_COLLISION:-}:$kind" in
			container:container)
				printf '%s\n' "[{\"Name\":\"/${LC_E2E_TEST_PROJECT}-app-1\",\"Config\":{\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}}]"
				;;
		volume:volume)
			printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_data\",\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}]"
			;;
		network:network)
			printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_private\",\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}]"
			;;
	esac
	if is_post_up_run; then
		case "$kind" in
			volume)
				printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_data\",\"Labels\":{\"com.docker.compose.project\":\"${LC_E2E_TEST_PROJECT}\",\"io.arr-dashboard.library-cleanup.project\":\"${LC_E2E_TEST_PROJECT}\",\"io.arr-dashboard.library-cleanup.run-token\":\"${LC_E2E_RUN_TOKEN}\",\"com.docker.compose.volume\":\"data\"}}]"
				;;
			network)
				printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_private\",\"Labels\":{\"com.docker.compose.project\":\"${LC_E2E_TEST_PROJECT}\",\"io.arr-dashboard.library-cleanup.project\":\"${LC_E2E_TEST_PROJECT}\",\"io.arr-dashboard.library-cleanup.run-token\":\"${LC_E2E_RUN_TOKEN}\",\"com.docker.compose.network\":\"private\"}}]"
				;;
		esac
	fi
	exit 0
fi

echo "unexpected fake docker invocation: $kind $command $*" >&2
exit 99
EOF
chmod +x "$FAKE_BIN_DIR/flock" "$FAKE_BIN_DIR/fake-compose" "$FAKE_BIN_DIR/docker"

run_start_profile() {
	mode=$1
	output_file=$2
	up_marker=$3
	PATH="$FAKE_BIN_DIR:$PATH" \
		ARR_COMPOSE_BIN="$FAKE_BIN_DIR/fake-compose" \
		LC_E2E_TEST_COMPOSE_LOG="$COMPOSE_LOG" \
		LC_E2E_TEST_PROFILE_MODE=$mode \
		LC_E2E_TEST_UP_MARKER=$up_marker \
		LC_E2E_TEST_PROJECT=lc-e2e-690-20260810 \
		LC_E2E_LOCK_ROOT="$TEMP_DIR/locks-$mode" \
		COMPOSE_PROJECT_NAME=lc-e2e-690-20260810 \
		LC_E2E_RUN_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		sh "$HARNESS_DIR/start-profile.sh" sqlite >"$output_file" 2>&1
}

if run_start_profile pre-conflict "$TEMP_DIR/pre-start.out" "$TEMP_DIR/pre-up"; then
	echo "sqlite startup accepted a running postgres dashboard" >&2
	cat "$TEMP_DIR/pre-start.out" >&2
	exit 1
fi

if grep -Eq '(^| )up( |$)' "$COMPOSE_LOG"; then
	echo "sqlite startup reached Compose up while postgres was running" >&2
	cat "$COMPOSE_LOG" >&2
	exit 1
fi

if ! grep -Fq 'dashboard-postgres' "$TEMP_DIR/pre-start.out"; then
	echo "profile conflict refusal did not identify the running dashboard" >&2
	cat "$TEMP_DIR/pre-start.out" >&2
	exit 1
fi

POST_UP_MARKER=$TEMP_DIR/post-up
if run_start_profile post-conflict "$TEMP_DIR/post-start.out" "$POST_UP_MARKER"; then
	echo "sqlite startup accepted postgres as the dashboard after Compose up" >&2
	cat "$TEMP_DIR/post-start.out" >&2
	exit 1
fi

if [ ! -f "$POST_UP_MARKER" ]; then
	echo "post-up dashboard test never reached Compose up" >&2
	cat "$COMPOSE_LOG" >&2
	exit 1
fi

if ! grep -Fq 'dashboard-postgres' "$TEMP_DIR/post-start.out"; then
	echo "post-up dashboard refusal did not identify the running dashboard" >&2
	cat "$TEMP_DIR/post-start.out" >&2
	exit 1
fi

assert_name_collision_stops_before_up() {
	kind=$1
	output_file=$TEMP_DIR/$kind-collision.out
	up_marker=$TEMP_DIR/$kind-collision-up
	if PATH="$FAKE_BIN_DIR:$PATH" \
		ARR_COMPOSE_BIN="$FAKE_BIN_DIR/fake-compose" \
		LC_E2E_TEST_COLLISION=$kind \
		LC_E2E_TEST_COMPOSE_LOG="$COMPOSE_LOG" \
		LC_E2E_TEST_PROFILE_MODE=empty \
		LC_E2E_TEST_PROJECT=lc-e2e-690-20260810 \
		LC_E2E_TEST_UP_MARKER=$up_marker \
		LC_E2E_LOCK_ROOT="$TEMP_DIR/locks-$kind" \
		COMPOSE_PROJECT_NAME=lc-e2e-690-20260810 \
		LC_E2E_RUN_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		sh "$HARNESS_DIR/start-profile.sh" sqlite >"$output_file" 2>&1; then
		echo "sqlite startup accepted a conflicting $kind name" >&2
		cat "$output_file" >&2
		exit 1
	fi
	if [ -f "$up_marker" ]; then
		echo "sqlite startup reached Compose up with a conflicting $kind name" >&2
		cat "$COMPOSE_LOG" >&2
		exit 1
	fi
}

assert_name_collision_stops_before_up volume
assert_name_collision_stops_before_up network
assert_name_collision_stops_before_up container

echo "dashboard profile ownership test passed."
