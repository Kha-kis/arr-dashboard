#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

"${SCRIPT_DIR}/preflight.sh"
PURGE_VOLUMES=1 "${SCRIPT_DIR}/teardown.sh"

if [[ ! -x "${SCRIPT_DIR}/bootstrap.sh" ]]; then
  echo "bootstrap.sh is not installed yet" >&2
  exit 1
fi

"${SCRIPT_DIR}/bootstrap.sh"
