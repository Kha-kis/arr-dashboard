#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-compose-command-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

FAKE_COMPOSE="$TEMP_DIR/fake-compose"
COMPOSE_LOG="$TEMP_DIR/compose.log"
FAKE_DOCKER_BIN_DIR="$TEMP_DIR/docker-bin"
FAKE_STANDALONE_BIN_DIR="$TEMP_DIR/standalone-bin"
EMPTY_BIN_DIR="$TEMP_DIR/empty-bin"
FAKE_HOME="$TEMP_DIR/home"
EMPTY_HOME="$TEMP_DIR/empty-home"
ISOLATED_DOCKER_CONFIG="$TEMP_DIR/isolated-docker-config"
SYSTEM_PATH=$PATH
mkdir -p \
	"$FAKE_DOCKER_BIN_DIR" \
	"$FAKE_STANDALONE_BIN_DIR" \
	"$EMPTY_BIN_DIR" \
	"$FAKE_HOME/.docker/cli-plugins" \
	"$EMPTY_HOME" \
	"$ISOLATED_DOCKER_CONFIG"

cat >"$FAKE_COMPOSE" <<'EOF'
#!/bin/sh
if [ "$1" = version ] && [ "$2" = --short ]; then
	printf '%s\n' 2.40.0
	exit 0
fi
{
	printf '%s\n' override
	printf '%s\n' "$@"
} >"$ARR_COMPOSE_LOG"
EOF
chmod +x "$FAKE_COMPOSE"

cat >"$FAKE_DOCKER_BIN_DIR/docker" <<'EOF'
#!/bin/sh
if [ "$1" = compose ] && [ "$2" = version ] && [ "$3" = --short ]; then
	printf '%s\n' 2.40.0
	exit 0
fi
{
	printf '%s\n' docker
	printf '%s\n' "$@"
} >"$ARR_COMPOSE_LOG"
EOF
chmod +x "$FAKE_DOCKER_BIN_DIR/docker"

cat >"$FAKE_STANDALONE_BIN_DIR/docker-compose" <<'EOF'
#!/bin/sh
if [ "$1" = version ] && [ "$2" = --short ]; then
	printf '%s\n' 2.40.0
	exit 0
fi
{
	printf '%s\n' docker-compose
	printf '%s\n' "$@"
} >"$ARR_COMPOSE_LOG"
EOF
chmod +x "$FAKE_STANDALONE_BIN_DIR/docker-compose"

FAKE_PLUGIN="$FAKE_HOME/.docker/cli-plugins/docker-compose"
cat >"$FAKE_PLUGIN" <<'EOF'
#!/bin/sh
if [ "$1" = version ] && [ "$2" = --short ]; then
	printf '%s\n' 5.1.0
	exit 0
fi
{
	printf '%s\n' plugin
	printf '%s\n' "$@"
} >"$ARR_COMPOSE_LOG"
EOF
chmod +x "$FAKE_PLUGIN"

cat >"$FAKE_STANDALONE_BIN_DIR/legacy-compose" <<'EOF'
#!/bin/sh
if [ "$1" = version ] && [ "$2" = --short ]; then
	printf '%s\n' 1.29.2
	exit 0
fi
exit 99
EOF
chmod +x "$FAKE_STANDALONE_BIN_DIR/legacy-compose"

assert_compose_args() {
	expected_command=$1
	expected_args="$TEMP_DIR/expected-args"
	{
		printf '%s\n' "$expected_command"
		if [ "$expected_command" = docker ]; then
			printf '%s\n' compose
		fi
		printf '%s\n' -p lc-e2e-contract
		printf '%s\n' -f "$SCRIPT_DIR/compose.yml"
		printf '%s\n' -f "$SCRIPT_DIR/compose.debug.yml"
		printf '%s\n' ps --status running --services
	} >"$expected_args"

	if ! cmp -s "$expected_args" "$COMPOSE_LOG"; then
		echo "compose helper did not select $expected_command with the isolated harness model." >&2
		diff -u "$expected_args" "$COMPOSE_LOG" >&2 || true
		exit 1
	fi
}

exercise_compose() {
	COMPOSE_PROJECT_NAME=lc-e2e-contract
	ARR_COMPOSE_LOG="$COMPOSE_LOG"
	export COMPOSE_PROJECT_NAME ARR_COMPOSE_LOG
	. "$SCRIPT_DIR/compose-command.sh"
	compose ps --status running --services
}

ARR_COMPOSE_BIN="$FAKE_COMPOSE"
export ARR_COMPOSE_BIN
exercise_compose
assert_compose_args override

unset ARR_COMPOSE_BIN
HOME="$EMPTY_HOME"
DOCKER_CONFIG="$ISOLATED_DOCKER_CONFIG"
PATH=$FAKE_DOCKER_BIN_DIR
export PATH HOME DOCKER_CONFIG
exercise_compose
PATH=$SYSTEM_PATH
export PATH
assert_compose_args docker

unset ARR_COMPOSE_BIN
PATH=$FAKE_STANDALONE_BIN_DIR
export PATH
exercise_compose
PATH=$SYSTEM_PATH
export PATH
assert_compose_args docker-compose

unset ARR_COMPOSE_BIN
PATH=$EMPTY_BIN_DIR
HOME="$FAKE_HOME"
export PATH
exercise_compose
PATH=$SYSTEM_PATH
export PATH
assert_compose_args plugin

unset ARR_COMPOSE_BIN
ln -s "$FAKE_STANDALONE_BIN_DIR/legacy-compose" "$EMPTY_BIN_DIR/docker-compose"
PATH=$EMPTY_BIN_DIR
HOME="$FAKE_HOME"
export PATH HOME
exercise_compose
PATH=$SYSTEM_PATH
export PATH
assert_compose_args plugin

for script in \
	bootstrap-arr.sh \
	bootstrap-dashboard.sh \
	bootstrap-plex.sh \
	bootstrap-qui.sh \
	bootstrap-torrents.sh \
	run-browser-policy.sh \
	run-live-scenario.sh \
	start-profile.sh \
	stop-profile.sh \
	teardown.sh \
	validate-compose.sh; do
	if ! grep -Fq '. "$SCRIPT_DIR/compose-command.sh"' "$SCRIPT_DIR/$script"; then
		echo "$script does not load the shared Compose helper." >&2
		exit 1
	fi
	if grep -Eq '(^|[^[:alnum:]_])(docker[[:space:]]+compose|COMPOSE_BIN=|run_compose[[:space:]]*\(|compose[[:space:]]*\()' "$SCRIPT_DIR/$script"; then
		echo "$script bypasses the shared Compose helper." >&2
		exit 1
	fi
done

echo "compose command contract and bypass checks passed."
