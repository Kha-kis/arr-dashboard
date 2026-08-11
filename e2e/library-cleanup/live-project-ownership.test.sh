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
EMPTY_BIN_DIR=$TEMP_DIR/empty-bin
WRAPPED_DOCKER="$TEMP_DIR/docker wrapper"
mkdir -p "$FAKE_BIN_DIR" "$EMPTY_BIN_DIR"

cat >"$EMPTY_BIN_DIR/docker" <<'EOF'
#!/bin/sh
echo "literal docker must not be used when --docker-bin is configured" >&2
exit 99
EOF
chmod +x "$EMPTY_BIN_DIR/docker"

cat >"$MODEL_FILE" <<EOF
{
  "services": {
    "app": {"image": "example:test", "volumes": [], "networks": {}},
    "named": {"container_name": "${PROJECT}-named-physical", "image": "example:test", "volumes": [], "networks": {}}
  },
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
			container-default)
				[ "$kind" = container ] && case " $* " in *' -a '*) printf '%s\n' "${LC_E2E_TEST_PROJECT}-app-1" ;; esac
				;;
			container-named)
				[ "$kind" = container ] && case " $* " in *' -a '*) printf '%s\n' "${LC_E2E_TEST_PROJECT}-named-physical" ;; esac
				;;
			volume) [ "$kind" = volume ] && printf '%s\n' "${LC_E2E_TEST_PROJECT}_data" ;;
				network) [ "$kind" = network ] && printf '%s\n' "${LC_E2E_TEST_PROJECT}_private" ;;
			esac
			;;
	esac
	exit 0
fi

if [ "$command" = inspect ]; then
		case "${LC_E2E_TEST_COLLISION:?}:$kind" in
			container-default:container)
				printf '%s\n' "[{\"Name\":\"/${LC_E2E_TEST_PROJECT}-app-1\",\"Config\":{\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}}]"
				;;
			container-named:container)
				printf '%s\n' "[{\"Name\":\"/${LC_E2E_TEST_PROJECT}-named-physical\",\"Config\":{\"Labels\":{\"com.docker.compose.project\":\"foreign\"}}}]"
				;;
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
cp "$FAKE_BIN_DIR/docker" "$WRAPPED_DOCKER"
chmod +x "$WRAPPED_DOCKER"

assert_rejects_collision() {
	kind=$1
	if PATH="$EMPTY_BIN_DIR:$PATH" \
		LC_E2E_TEST_COLLISION=$kind \
		LC_E2E_TEST_PROJECT=$PROJECT \
		python3 "$SCRIPT_DIR/check-live-project.py" \
			--model "$MODEL_FILE" \
			--hashes "$HASH_FILE" \
			--project "$PROJECT" \
		--run-token "$TOKEN" \
		--docker-bin "$WRAPPED_DOCKER" \
			--config-files /workspace/compose.yml,/workspace/compose.debug.yml \
			--working-dir /workspace \
			--allow-empty >"$TEMP_DIR/$kind.out" 2>&1; then
		echo "ownership check accepted an existing $kind with the rendered physical name" >&2
		cat "$TEMP_DIR/$kind.out" >&2
		exit 1
	fi
	case "$kind" in
		container-default) expected_name="${PROJECT}-app-1" ;;
		container-named) expected_name="${PROJECT}-named-physical" ;;
		*) expected_name="${PROJECT}_" ;;
	esac
	if ! grep -Fq "$expected_name" "$TEMP_DIR/$kind.out"; then
		echo "ownership check rejected the $kind collision without identifying its physical name" >&2
		cat "$TEMP_DIR/$kind.out" >&2
		exit 1
	fi
}

assert_rejects_collision volume
assert_rejects_collision network
assert_rejects_collision container-default
assert_rejects_collision container-named

echo "live project exact-name ownership tests passed."
