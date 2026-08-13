#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

purge_volumes="${PURGE_VOLUMES:-0}"
if [[ "$purge_volumes" != "0" && "$purge_volumes" != "1" ]]; then
  echo "PURGE_VOLUMES must be 0 or 1" >&2
  exit 1
fi

assert_owned_resources

if [[ "$purge_volumes" == "1" ]]; then
  compose down --remove-orphans -v
else
  compose down --remove-orphans
fi
