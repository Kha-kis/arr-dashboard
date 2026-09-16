#!/bin/sh
set -eu

: "${COMPOSE_PROJECT_NAME:?Set a unique jf-authority-* project name}"
: "${JF_AUTHORITY_RUN_TOKEN:?Set a random 64-character lowercase hex run token}"
: "${CANDIDATE_DASHBOARD_IMAGE:?Set the immutable candidate dashboard image}"

case "$COMPOSE_PROJECT_NAME" in
	jf-authority-[a-z0-9-]*) ;;
	*) echo "refusing unsafe project name" >&2; exit 2 ;;
esac
if [ "${#JF_AUTHORITY_RUN_TOKEN}" -ne 64 ]; then
	echo "refusing invalid run token length" >&2
	exit 2
fi
case "$JF_AUTHORITY_RUN_TOKEN" in
	*[!a-f0-9]*) echo "refusing non-hex run token" >&2; exit 2 ;;
esac

COMPOSE_BIN="${COMPOSE_BIN:-$HOME/.docker/cli-plugins/docker-compose}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose() {
	"$COMPOSE_BIN" -p "$COMPOSE_PROJECT_NAME" -f "$HERE/compose.yml" --profile tools "$@"
}

node "$HERE/teardown.mjs" --if-present

cleanup() {
	run_status=$?
	trap - 0
	if ! node "$HERE/teardown.mjs" --if-present; then
		if [ "$run_status" -eq 0 ]; then
			run_status=1
		fi
	fi
	exit "$run_status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose up -d --wait dashboard jellyfin jellyfin-proxy
for phase in bootstrap boxset pagination shapes recovery rotation; do
	compose restart dashboard
	compose up -d --wait dashboard
	compose run --rm matrix-runner "$phase"
done
