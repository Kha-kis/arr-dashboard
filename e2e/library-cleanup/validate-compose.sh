#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
REQUIRE_LIVE_NAME=0
EXPECTED_PROJECT=""

if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--live-project" ]; then
    echo "usage: sh ./validate-compose.sh [--live-project lc-e2e-<unique-run>]" >&2
    exit 2
  fi
  REQUIRE_LIVE_NAME=1
  EXPECTED_PROJECT=$2
  COMPOSE_PROJECT_NAME=$EXPECTED_PROJECT
  export COMPOSE_PROJECT_NAME
elif [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  COMPOSE_PROJECT_NAME=lc-e2e-static-validation
  export COMPOSE_PROJECT_NAME
fi

. "$SCRIPT_DIR/compose-command.sh"

if ! compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is not available." >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for the non-destructive Compose safety checks." >&2
  exit 2
fi

sh "$SCRIPT_DIR/provenance-helpers.test.sh"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-compose.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
umask 077

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  if [ -z "${POSTGRES_PASSWORD_FILE:-}" ]; then
    POSTGRES_PASSWORD_FILE="$TEMP_DIR/postgres-password.txt"
    printf '%s\n' 'compose-validation-only' >"$POSTGRES_PASSWORD_FILE"
    export POSTGRES_PASSWORD_FILE
  fi
  if [ -z "${PLEX_CLAIM_FILE:-}" ]; then
    PLEX_CLAIM_FILE="$TEMP_DIR/plex-claim.txt"
    : >"$PLEX_CLAIM_FILE"
    export PLEX_CLAIM_FILE
  fi
fi

cd "$SCRIPT_DIR"
python3 check-dockerignore.py "$REPO_ROOT/.dockerignore" --self-test

check_base_model() {
  if [ "$REQUIRE_LIVE_NAME" -eq 1 ]; then
    python3 check-compose-model.py \
      --self-test \
      --require-live-name \
      --expected-project "$EXPECTED_PROJECT"
  else
    python3 check-compose-model.py --self-test
  fi
}

compose_base \
  --profile candidate-sqlite \
  --profile candidate-postgres \
  --profile baseline \
	config --format json | check_base_model

check_debug_model() {
  if [ "$REQUIRE_LIVE_NAME" -eq 1 ]; then
    python3 check-compose-model.py \
      --require-live-name \
      --expected-project "$EXPECTED_PROJECT"
  else
    python3 check-compose-model.py
  fi
}

compose \
  --profile candidate-sqlite \
  --profile candidate-postgres \
  --profile baseline \
	config --format json | check_debug_model

echo "Compose syntax and safety checks passed without building, pulling, or starting services."
