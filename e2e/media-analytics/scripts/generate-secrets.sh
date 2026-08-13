#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HARNESS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
STATE_DIR="${HARNESS_DIR}/.state"
RUNTIME_ENV="${STATE_DIR}/runtime.env"

assert_runtime_env_permissions() {
	local mode owner
	mode="$(stat -c '%a' "$RUNTIME_ENV")"
	owner="$(stat -c '%u' "$RUNTIME_ENV")"
	if [[ "$mode" != "600" || "$owner" != "$(id -u)" ]]; then
		echo "refusing unsafe runtime state file permissions" >&2
		return 1
	fi
}

if [[ -e "$RUNTIME_ENV" ]]; then
	if [[ ! -f "$RUNTIME_ENV" ]]; then
		echo "refusing non-file runtime state path" >&2
		exit 1
	fi
	assert_runtime_env_permissions
	exit 0
fi

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

runtime_tmp="$(mktemp "${STATE_DIR}/runtime.env.XXXXXX")"
trap 'rm -f "$runtime_tmp"' EXIT

cat > "$runtime_tmp" <<EOF
TRACEARR_JWT_SECRET=$(openssl rand -hex 32)
TRACEARR_COOKIE_SECRET=$(openssl rand -hex 32)
TRACEARR_DB_PASSWORD=$(openssl rand -hex 24)
TAUTULLI_API_KEY=$(openssl rand -hex 16)
PLEX_LOCAL_TOKEN=$(openssl rand -hex 32)
DASHBOARD_ADMIN_PASSWORD=$(openssl rand -hex 24)
API_TEST_STATE=$(openssl rand -hex 16)
EOF

chmod 0600 "$runtime_tmp"
mv "$runtime_tmp" "$RUNTIME_ENV"
trap - EXIT
assert_runtime_env_permissions
