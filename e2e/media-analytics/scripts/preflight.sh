#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

assert_loopback_url "${DASHBOARD_URL:-http://127.0.0.1:3000}"

require_command docker
require_command curl
require_command jq
require_command openssl
docker compose version >/dev/null

mkdir -p "${HARNESS_DIR}/.state"
chmod 0700 "${HARNESS_DIR}/.state"

compose config --quiet
