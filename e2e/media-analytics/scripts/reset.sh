#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

"${SCRIPT_DIR}/preflight.sh"
PURGE_VOLUMES=1 "${SCRIPT_DIR}/teardown.sh"

"${SCRIPT_DIR}/bootstrap.sh"
