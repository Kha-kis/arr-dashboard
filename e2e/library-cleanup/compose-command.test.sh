#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-compose-command-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

FAKE_COMPOSE="$TEMP_DIR/fake-compose"
COMPOSE_LOG="$TEMP_DIR/compose.log"
cat >"$FAKE_COMPOSE" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"$ARR_COMPOSE_LOG"
EOF
chmod +x "$FAKE_COMPOSE"

COMPOSE_PROJECT_NAME=lc-e2e-contract
ARR_COMPOSE_BIN="$FAKE_COMPOSE"
ARR_COMPOSE_LOG="$COMPOSE_LOG"
export COMPOSE_PROJECT_NAME ARR_COMPOSE_BIN ARR_COMPOSE_LOG

. "$SCRIPT_DIR/compose-command.sh"
compose ps --status running --services

expected_args="$TEMP_DIR/expected-args"
{
	printf '%s\n' -p lc-e2e-contract
	printf '%s\n' -f "$SCRIPT_DIR/compose.yml"
	printf '%s\n' -f "$SCRIPT_DIR/compose.debug.yml"
	printf '%s\n' ps --status running --services
} >"$expected_args"

if ! cmp -s "$expected_args" "$COMPOSE_LOG"; then
	echo "compose helper did not invoke ARR_COMPOSE_BIN with the isolated harness model." >&2
	diff -u "$expected_args" "$COMPOSE_LOG" >&2 || true
	exit 1
fi

for script in \
	bootstrap-arr.sh \
	bootstrap-dashboard.sh \
	bootstrap-plex.sh \
	bootstrap-qui.sh \
	run-browser-policy.sh \
	run-live-scenario.sh \
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
