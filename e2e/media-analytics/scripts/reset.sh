#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

if [[ -z "${PLEX_CLAIM:-}" ]]; then
  echo "media analytics reset requires an invocation-only PLEX_CLAIM before deleting retained volumes" >&2
  exit 1
fi
if [[ -n "${PLEX_TOKEN:-}" ]]; then
  echo "PLEX_TOKEN is not accepted; reset uses Plex's server-issued token after claim exchange" >&2
  exit 1
fi

acquire_lifecycle_lock
"${SCRIPT_DIR}/preflight.sh"
PURGE_VOLUMES=1 "${SCRIPT_DIR}/teardown.sh"

"${SCRIPT_DIR}/bootstrap.sh"
