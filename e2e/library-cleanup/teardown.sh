#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -ne 4 ] || [ "$1" != "--project" ] || [ "$3" != "--confirm" ]; then
  echo "usage: sh ./teardown.sh --project lc-e2e-<unique-run> --confirm lc-e2e-<unique-run>" >&2
  exit 2
fi

PROJECT_NAME=$2
CONFIRMED_PROJECT=$4
if [ "$PROJECT_NAME" != "$CONFIRMED_PROJECT" ]; then
  echo "teardown refused: --confirm must exactly match --project" >&2
  exit 1
fi

COMPOSE_PROJECT_NAME=$PROJECT_NAME
export COMPOSE_PROJECT_NAME
. "$SCRIPT_DIR/compose-command.sh"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-teardown.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
umask 077
POSTGRES_PASSWORD_FILE="$TEMP_DIR/postgres-password.txt"
PLEX_CLAIM_FILE="$TEMP_DIR/plex-claim.txt"
printf '%s\n' 'teardown-validation-only' >"$POSTGRES_PASSWORD_FILE"
: >"$PLEX_CLAIM_FILE"
export POSTGRES_PASSWORD_FILE PLEX_CLAIM_FILE

# The live preflight rejects empty, malformed, generic, and production-like
# names; checks the exact harness service/model contract; validates secrets;
# and accepts no caller-supplied Compose files or external paths.
sh "$SCRIPT_DIR/validate-compose.sh" --live-project "$PROJECT_NAME"

echo "Removing only disposable project $PROJECT_NAME, including its named volumes."
compose \
	--profile candidate-sqlite \
  --profile candidate-postgres \
  --profile baseline \
	down --volumes --remove-orphans
