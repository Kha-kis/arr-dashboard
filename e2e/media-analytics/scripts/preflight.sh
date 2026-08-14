#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

dashboard_url="http://127.0.0.1:${DASHBOARD_PORT}"
assert_loopback_url "$dashboard_url"
if [[ -n "${DASHBOARD_URL:-}" ]]; then
  assert_loopback_url "$DASHBOARD_URL"
  if [[ "$DASHBOARD_URL" != "$dashboard_url" ]]; then
    echo "DASHBOARD_URL must match the configured DASHBOARD_PORT" >&2
    exit 1
  fi
fi

require_command docker
require_command curl
require_command jq
require_command openssl
require_command flock
docker compose version >/dev/null

mkdir -p "${HARNESS_DIR}/.state/media"
chmod 0700 "${HARNESS_DIR}/.state"

compose config --quiet
