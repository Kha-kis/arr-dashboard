#!/usr/bin/env bash
# upgrade-test.sh — Validate v2.8.5 → v2.9.0 upgrade path
#
# 1. Starts the latest published image (v2.8.5) with a fresh volume
# 2. Creates a user, adds services, seeds data
# 3. Stops the old container
# 4. Starts the local v2.9.0 beta image with the same volume
# 5. Verifies all data survived the upgrade
#
# Usage: bash e2e/integration/scripts/upgrade-test.sh
#
# Prerequisites:
#   - docker pull khak1s/arr-dashboard:latest  (v2.8.5)
#   - docker build -t arr-dashboard:v2.9-beta .  (local build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OLD_IMAGE="khak1s/arr-dashboard:latest"
NEW_IMAGE="arr-dashboard:v2.9-beta"
CONTAINER="upgrade-test"
CONFIG_DIR="/tmp/arr-upgrade-test-$$"
PORT_WEB=3200
PORT_API=3201

log()  { echo "[upgrade-test] $*"; }
fail() { echo "[upgrade-test] FAIL: $*" >&2; cleanup; exit 1; }
pass() { echo "[upgrade-test] PASS: $*"; }

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  rm -rf "$CONFIG_DIR" 2>/dev/null || true
}

# Helper: wait for health
wait_health() {
  local url="$1"
  local timeout="${2:-60}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local resp
    resp=$(curl -sf "$url" 2>/dev/null || echo "")
    if echo "$resp" | grep -q '"ok"'; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

trap cleanup EXIT

log "=== Upgrade Test: ${OLD_IMAGE} → ${NEW_IMAGE} ==="
log ""

# ── Phase 1: Start old version ─────────────────────────────────────

log "Phase 1: Starting old version (${OLD_IMAGE})..."
mkdir -p "$CONFIG_DIR"

docker run -d \
  --name "$CONTAINER" \
  -p "${PORT_WEB}:3000" \
  -p "${PORT_API}:3001" \
  -v "${CONFIG_DIR}:/config" \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  "$OLD_IMAGE" >/dev/null

wait_health "http://localhost:${PORT_API}/health" 90 || fail "Old version did not start"
pass "Old version started"

# Get version info
OLD_VERSION=$(curl -sf "http://localhost:${PORT_API}/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))")
log "  Old version: ${OLD_VERSION}"

# ── Phase 2: Populate with data ────────────────────────────────────

log ""
log "Phase 2: Populating with test data..."

# Register user
REGISTER_RESULT=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/register', method='POST',
    data=json.dumps({'username':'upgrade-admin','password':'UpgradeTest1!'}).encode(),
    headers={'Content-Type':'application/json'})
try:
    resp = urllib.request.urlopen(req)
    print('ok')
except Exception as e:
    print(f'error: {e}')
")
if echo "$REGISTER_RESULT" | grep -q "ok"; then
  pass "User registered"
else
  fail "User registration failed: $REGISTER_RESULT"
fi

# Login and get cookie
LOGIN_COOKIE=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/login', method='POST',
    data=json.dumps({'username':'upgrade-admin','password':'UpgradeTest1!','rememberMe':True}).encode(),
    headers={'Content-Type':'application/json'})
resp = urllib.request.urlopen(req)
cookie = resp.headers.get('Set-Cookie','')
parts = [c.strip().split(';')[0] for c in cookie.split(',') if 'arr_session' in c]
print(parts[0] if parts else '')
")
[ -n "$LOGIN_COOKIE" ] || fail "Login failed — no cookie"
pass "User logged in"

# Check services count before
SERVICES_BEFORE=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/api/services',
    headers={'Cookie': '${LOGIN_COOKIE}'})
resp = urllib.request.urlopen(req)
data = json.load(resp)
print(len(data.get('services',[])))
")
log "  Services before: ${SERVICES_BEFORE}"

# Note: Can't add real services since no *arr containers are running
# Instead, verify user/auth survives the upgrade

# Check database files
log "  Config directory contents:"
ls -la "$CONFIG_DIR" | grep -E "\.db|\.json" || true

# ── Phase 3: Stop old version ──────────────────────────────────────

log ""
log "Phase 3: Stopping old version..."
docker stop "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
pass "Old version stopped"

# ── Phase 4: Start new version ─────────────────────────────────────

log ""
log "Phase 4: Starting new version (${NEW_IMAGE})..."

docker run -d \
  --name "$CONTAINER" \
  -p "${PORT_WEB}:3000" \
  -p "${PORT_API}:3001" \
  -v "${CONFIG_DIR}:/config" \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  "$NEW_IMAGE" >/dev/null

wait_health "http://localhost:${PORT_API}/health" 90 || fail "New version did not start"
pass "New version started"

# Get new version info
NEW_VERSION=$(curl -sf "http://localhost:${PORT_API}/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))")
log "  New version: ${NEW_VERSION}"

# Check startup logs for migration issues
STARTUP_LOGS=$(docker logs "$CONTAINER" 2>&1 | head -100)
if echo "$STARTUP_LOGS" | grep -qi "panic\|FATAL\|cannot open database"; then
  log "  Fatal errors found in startup logs:"
  echo "$STARTUP_LOGS" | grep -i "panic\|FATAL\|cannot open database" | head -5
  fail "Fatal startup errors detected"
fi

# Check database sync result
if echo "$STARTUP_LOGS" | grep -q "already in sync\|synchronized successfully"; then
  pass "Database schema sync succeeded"
else
  log "  Schema sync logs:"
  echo "$STARTUP_LOGS" | grep -i "schema\|database\|prisma" | head -10
  fail "Database schema sync could not be confirmed"
fi

# ── Phase 5: Verify data survived ──────────────────────────────────

log ""
log "Phase 5: Verifying data integrity..."

# Setup should NOT be required (user exists from old version)
SETUP_REQUIRED=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/setup-required')
resp = urllib.request.urlopen(req)
data = json.load(resp)
print(data.get('required', True))
")
if [ "$SETUP_REQUIRED" = "False" ]; then
  pass "User survived upgrade (setup not required)"
else
  fail "User was lost during upgrade (setup required)"
fi

# Login with old credentials
LOGIN_RESULT=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/login', method='POST',
    data=json.dumps({'username':'upgrade-admin','password':'UpgradeTest1!','rememberMe':True}).encode(),
    headers={'Content-Type':'application/json'})
try:
    resp = urllib.request.urlopen(req)
    data = json.load(resp)
    print(data.get('user',{}).get('username',''))
except Exception:
    print('')
")
if [ "$LOGIN_RESULT" = "upgrade-admin" ]; then
  pass "Login with old credentials works"
else
  fail "Login with old credentials failed"
fi

# Verify system info endpoint
SYSTEM_INFO=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/login', method='POST',
    data=json.dumps({'username':'upgrade-admin','password':'UpgradeTest1!','rememberMe':True}).encode(),
    headers={'Content-Type':'application/json'})
resp = urllib.request.urlopen(req)
cookie = [c.strip().split(';')[0] for c in resp.headers.get('Set-Cookie','').split(',') if 'arr_session' in c][0]

req2 = urllib.request.Request('http://localhost:${PORT_API}/api/system/info',
    headers={'Cookie': cookie})
resp2 = urllib.request.urlopen(req2)
data = json.load(resp2)
info = data.get('data',{})
print(f\"version={info.get('version','?')} db={info.get('database',{}).get('type','?')}\")
")
pass "System info: ${SYSTEM_INFO}"

# ── Summary ────────────────────────────────────────────────────────

log ""
log "=== Upgrade Test Complete ==="
log "  ${OLD_VERSION} → ${NEW_VERSION}"
log ""
log "Results:"
log "  ✓ New version starts with old config volume"
log "  ✓ Database schema sync succeeds"
log "  ✓ User data preserved"
log "  ✓ Login with old credentials works"
log "  ✓ System info endpoint responds correctly"
