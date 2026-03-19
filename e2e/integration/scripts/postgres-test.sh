#!/usr/bin/env bash
# postgres-test.sh — Validate arr-dashboard works with PostgreSQL backend
#
# 1. Starts a PostgreSQL container
# 2. Starts arr-dashboard with DATABASE_URL pointing to PostgreSQL
# 3. Verifies health, registration, login, and API endpoints
# 4. Confirms database type is reported as PostgreSQL
#
# Usage: bash e2e/integration/scripts/postgres-test.sh
#
# Prerequisites:
#   - docker build -t arr-dashboard:v2.9-beta .  (local build)

set -euo pipefail

CONTAINER_PG="pg-test-db"
CONTAINER_APP="pg-test-app"
NETWORK="pg-test-net"
PORT_WEB=3300
PORT_API=3301
PG_PASSWORD="testpassword123"
PG_DB="arr_dashboard_test"

log()  { echo "[postgres-test] $*"; }
fail() { echo "[postgres-test] FAIL: $*" >&2; cleanup; exit 1; }
pass() { echo "[postgres-test] PASS: $*"; }

cleanup() {
  docker rm -f "$CONTAINER_APP" "$CONTAINER_PG" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
}

wait_health() {
  local url="$1"
  local timeout="${2:-90}"
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

log "=== PostgreSQL Backend Test ==="
log ""

# ── Step 1: Create network and start PostgreSQL ────────────────────

log "Step 1: Starting PostgreSQL..."
docker network create "$NETWORK" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER_PG" \
  --network "$NETWORK" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine >/dev/null

# Wait for PostgreSQL to be ready
log "  Waiting for PostgreSQL to accept connections..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_PG" pg_isready -U postgres >/dev/null 2>&1; then
    pass "PostgreSQL ready"
    break
  fi
  [ "$i" -eq 30 ] && fail "PostgreSQL did not start"
  sleep 2
done

# ── Step 2: Start arr-dashboard with PostgreSQL ────────────────────

log ""
log "Step 2: Starting arr-dashboard with PostgreSQL backend..."

docker run -d \
  --name "$CONTAINER_APP" \
  --network "$NETWORK" \
  -p "${PORT_WEB}:3000" \
  -p "${PORT_API}:3001" \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  -e DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@${CONTAINER_PG}:5432/${PG_DB}" \
  arr-dashboard:v2.9-beta >/dev/null

wait_health "http://localhost:${PORT_API}/health" 120 || {
  log "Container logs:"
  docker logs "$CONTAINER_APP" 2>&1 | tail -20
  fail "arr-dashboard did not start with PostgreSQL"
}
pass "arr-dashboard started with PostgreSQL"

# Check startup logs for provider switch
STARTUP_LOGS=$(docker logs "$CONTAINER_APP" 2>&1 | head -100)
if echo "$STARTUP_LOGS" | grep -qi "postgresql"; then
  pass "PostgreSQL provider detected in logs"
fi

if echo "$STARTUP_LOGS" | grep -q "synchronized successfully\|already in sync"; then
  pass "Database schema sync succeeded"
else
  log "  Schema sync logs:"
  echo "$STARTUP_LOGS" | grep -i "schema\|database\|prisma" | head -10
  fail "Database schema sync could not be confirmed on PostgreSQL"
fi

# ── Step 3: Verify functionality ───────────────────────────────────

log ""
log "Step 3: Verifying functionality..."

# Health check
VERSION=$(curl -sf "http://localhost:${PORT_API}/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','?'))")
pass "Health: version=${VERSION}"

# Registration
REG_RESULT=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/register', method='POST',
    data=json.dumps({'username':'pg-admin','password':'PgTest@1234!'}).encode(),
    headers={'Content-Type':'application/json'})
try:
    resp = urllib.request.urlopen(req)
    print('ok')
except Exception as e:
    print(f'error: {e}')
")
[ "$REG_RESULT" = "ok" ] && pass "User registration works" || fail "Registration failed: $REG_RESULT"

# Login
LOGIN_RESULT=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/auth/login', method='POST',
    data=json.dumps({'username':'pg-admin','password':'PgTest@1234!','rememberMe':True}).encode(),
    headers={'Content-Type':'application/json'})
resp = urllib.request.urlopen(req)
data = json.load(resp)
cookie = [c.strip().split(';')[0] for c in resp.headers.get('Set-Cookie','').split(',') if 'arr_session' in c][0]
print(cookie)
")
[ -n "$LOGIN_RESULT" ] && pass "Login works" || fail "Login failed"

# System info — verify PostgreSQL is reported
SYSTEM_INFO=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/api/system/info',
    headers={'Cookie': '${LOGIN_RESULT}'})
resp = urllib.request.urlopen(req)
data = json.load(resp)
info = data.get('data',{})
db = info.get('database',{})
print(f\"{db.get('type','?')}|{db.get('host','?')}\")
")
DB_TYPE=$(echo "$SYSTEM_INFO" | cut -d'|' -f1)
if [ "$DB_TYPE" = "PostgreSQL" ]; then
  pass "Database type correctly reported as PostgreSQL"
else
  fail "Expected PostgreSQL, got: ${DB_TYPE}"
fi

# Services endpoint
SERVICES_RESULT=$(python3 -c "
import urllib.request, json
req = urllib.request.Request('http://localhost:${PORT_API}/api/services',
    headers={'Cookie': '${LOGIN_RESULT}'})
resp = urllib.request.urlopen(req)
data = json.load(resp)
print(len(data.get('services',[])))
")
pass "Services endpoint works (${SERVICES_RESULT} services)"

# ── Summary ────────────────────────────────────────────────────────

log ""
log "=== PostgreSQL Backend Test Complete ==="
log ""
log "Results:"
log "  ✓ PostgreSQL container starts and accepts connections"
log "  ✓ arr-dashboard starts with PostgreSQL DATABASE_URL"
log "  ✓ Prisma schema sync succeeds on PostgreSQL"
log "  ✓ User registration and login work"
log "  ✓ System info reports PostgreSQL backend"
log "  ✓ API endpoints respond correctly"
