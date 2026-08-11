#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
. "$SCRIPT_DIR/compose-command.sh"
RUNNER_SERVICE=${ARR_BOOTSTRAP_RUNNER_SERVICE:-dashboard-sqlite}
CONFIG_TIMEOUT_SECONDS=${ARR_BOOTSTRAP_CONFIG_TIMEOUT_SECONDS:-120}
POLL_SECONDS=2

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres | dashboard-baseline) ;;
	*)
		echo "ARR bootstrap refused: unsupported runner service $RUNNER_SERVICE." >&2
		exit 1
		;;
esac

DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
export DOCKER_CONFIG
cd "$SCRIPT_DIR"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-arr-bootstrap.XXXXXX")
umask 077
RUNNER_DIR=/tmp/lc-e2e-arr-bootstrap-$PROJECT_NAME
RUNNER_SCRIPT=$RUNNER_DIR/bootstrap-arr.mjs

cleanup() {
	if [ "${RUNNER_PREPARED:-0}" -eq 1 ]; then
		compose exec -T --user 0 "$RUNNER_SERVICE" rm -f "$RUNNER_SCRIPT" \
			>/dev/null 2>&1 || true
		compose exec -T --user 0 "$RUNNER_SERVICE" rmdir "$RUNNER_DIR" \
			>/dev/null 2>&1 || true
	fi
	rm -rf "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Render and validate the exact live model with the standalone Compose plugin.
# This avoids Docker Desktop's credential-helper path while preserving the
# harness's unique-project, named-volume, network, and loopback checks.
if [ ! -f "$SCRIPT_DIR/.env" ]; then
	if [ -z "${POSTGRES_PASSWORD_FILE:-}" ]; then
		POSTGRES_PASSWORD_FILE=$TEMP_DIR/postgres-password.txt
		printf '%s\n' compose-validation-only >"$POSTGRES_PASSWORD_FILE"
		export POSTGRES_PASSWORD_FILE
	fi
	if [ -z "${PLEX_CLAIM_FILE:-}" ]; then
		PLEX_CLAIM_FILE=$TEMP_DIR/plex-claim.txt
		: >"$PLEX_CLAIM_FILE"
		export PLEX_CLAIM_FILE
	fi
fi

python3 check-dockerignore.py "$REPO_ROOT/.dockerignore" --self-test

BASE_MODEL=$TEMP_DIR/base-model.json
compose_base \
	--profile candidate-sqlite \
	--profile candidate-postgres \
	--profile baseline \
	config --format json >"$BASE_MODEL"
python3 check-compose-model.py \
	--self-test \
	--require-live-name \
	--expected-project "$PROJECT_NAME" <"$BASE_MODEL"

DEBUG_MODEL=$TEMP_DIR/debug-model.json
compose \
	--profile candidate-sqlite \
	--profile candidate-postgres \
	--profile baseline \
	config --format json >"$DEBUG_MODEL"
python3 check-compose-model.py \
	--require-live-name \
	--expected-project "$PROJECT_NAME" <"$DEBUG_MODEL"

require_running_service() {
	rrs_service=$1
	if ! compose ps --status running --services | grep -Fxq "$rrs_service"; then
		echo "ARR bootstrap refused: $rrs_service is not running in $PROJECT_NAME." >&2
		exit 1
	fi
}

extract_api_key() {
	eak_service=$1
	eak_destination=$2
	eak_elapsed=0

	while [ "$eak_elapsed" -lt "$CONFIG_TIMEOUT_SECONDS" ]; do
		eak_key=$(compose exec -T "$eak_service" sh -c \
			"sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' /config/config.xml | head -n 1" \
			2>/dev/null || true)
		case "$eak_key" in
			"") ;;
			*[!A-Za-z0-9_-]*)
				unset eak_key
				echo "ARR bootstrap refused: $eak_service returned a malformed API key." >&2
				exit 1
				;;
			*)
				printf '%s' "$eak_key" >"$eak_destination"
				unset eak_key
				return 0
				;;
		esac
		unset eak_key
		sleep "$POLL_SECONDS"
		eak_elapsed=$((eak_elapsed + POLL_SECONDS))
	done

	echo "ARR bootstrap failed: $eak_service did not produce /config/config.xml in time." >&2
	exit 1
}

for service in radarr-a radarr-b sonarr-a sonarr-b "$RUNNER_SERVICE"; do
	require_running_service "$service"
done

RADARR_A_KEY_FILE=$TEMP_DIR/radarr-a
RADARR_B_KEY_FILE=$TEMP_DIR/radarr-b
SONARR_A_KEY_FILE=$TEMP_DIR/sonarr-a
SONARR_B_KEY_FILE=$TEMP_DIR/sonarr-b

extract_api_key radarr-a "$RADARR_A_KEY_FILE"
extract_api_key radarr-b "$RADARR_B_KEY_FILE"
extract_api_key sonarr-a "$SONARR_A_KEY_FILE"
extract_api_key sonarr-b "$SONARR_B_KEY_FILE"

CREDENTIALS_FILE=$TEMP_DIR/credentials.json
{
	printf '{"RADARR_A_KEY":"'
	tr -d '\r\n' <"$RADARR_A_KEY_FILE"
	printf '","RADARR_B_KEY":"'
	tr -d '\r\n' <"$RADARR_B_KEY_FILE"
	printf '","SONARR_A_KEY":"'
	tr -d '\r\n' <"$SONARR_A_KEY_FILE"
	printf '","SONARR_B_KEY":"'
	tr -d '\r\n' <"$SONARR_B_KEY_FILE"
	printf '"}'
} >"$CREDENTIALS_FILE"

COMPOSE_PROJECT_NAME=$PROJECT_NAME \
	FIXTURE_PUID=${PUID:-1000} \
	FIXTURE_PGID=${PGID:-1000} \
	node "$SCRIPT_DIR/bootstrap-arr.mjs" --filesystem-only

compose exec -T --user 0 "$RUNNER_SERVICE" mkdir -p "$RUNNER_DIR"
RUNNER_PREPARED=1
compose cp "$SCRIPT_DIR/bootstrap-arr.mjs" "$RUNNER_SERVICE:$RUNNER_SCRIPT" >/dev/null
compose exec -T --interactive \
	-e COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
	"$RUNNER_SERVICE" node "$RUNNER_SCRIPT" --api-only <"$CREDENTIALS_FILE"

echo "ARR/media fixture bootstrap completed over the isolated Compose network without exposing API keys."
