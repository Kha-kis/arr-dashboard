#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-live-project-ownership-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

PROJECT=lc-e2e-690-20260810
TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MODEL_FILE=$TEMP_DIR/model.json
HASH_FILE=$TEMP_DIR/hashes.txt
FAKE_BIN_DIR=$TEMP_DIR/bin
mkdir -p "$FAKE_BIN_DIR"

cat >"$MODEL_FILE" <<EOF
{
  "services": {"app": {"image": "example:test", "volumes": [], "networks": {}}},
  "volumes": {"data": {"name": "${PROJECT}_data"}},
  "networks": {"private": {"name": "${PROJECT}_private"}}
}
EOF
printf '%s\n' 'app hash' >"$HASH_FILE"

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/bin/sh
set -eu

kind=$1
command=$2
shift 2

if [ "$command" = ls ]; then

	case " $* " in
		*' --format '*)
			case "${LC_E2E_TEST_COLLISION:?}" in
				volume) [ "$kind" = volume ] && printf '%s\n' "${LC_E2E_TEST_PROJECT}_data" ;;
				network) [ "$kind" = network ] && printf '%s\n' "${LC_E2E_TEST_PROJECT}_private" ;;
			esac
			;;
	esac
	exit 0
fi

if [ "$command" = inspect ]; then
	case "${LC_E2E_TEST_COLLISION:?}:$kind" in
		volume:volume)
			printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_data\",\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}]"
			;;
		network:network)
			printf '%s\n' "[{\"Name\":\"${LC_E2E_TEST_PROJECT}_private\",\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}]"
			;;
	esac
	exit 0
fi

echo "unexpected fake docker invocation: $kind $command $*" >&2
exit 99
EOF
chmod +x "$FAKE_BIN_DIR/docker"

assert_rejects_collision() {
	kind=$1
	if PATH="$FAKE_BIN_DIR:$PATH" \
		LC_E2E_TEST_COLLISION=$kind \
		LC_E2E_TEST_PROJECT=$PROJECT \
		python3 "$SCRIPT_DIR/check-live-project.py" \
			--model "$MODEL_FILE" \
			--hashes "$HASH_FILE" \
			--project "$PROJECT" \
			--run-token "$TOKEN" \
			--config-files /workspace/compose.yml,/workspace/compose.debug.yml \
			--working-dir /workspace \
			--allow-empty >"$TEMP_DIR/$kind.out" 2>&1; then
		echo "ownership check accepted an existing $kind with the rendered physical name" >&2
		cat "$TEMP_DIR/$kind.out" >&2
		exit 1
	fi
	if ! grep -Fq "${PROJECT}_" "$TEMP_DIR/$kind.out"; then
		echo "ownership check rejected the $kind collision without identifying its physical name" >&2
		cat "$TEMP_DIR/$kind.out" >&2
		exit 1
	fi
}

assert_rejects_collision volume
assert_rejects_collision network

echo "live project exact-name ownership tests passed."
