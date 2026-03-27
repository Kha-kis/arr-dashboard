#!/usr/bin/env bash
# bootstrap-services.sh — Extract API keys from *arr containers and write .env.services
#
# LinuxServer *arr images auto-generate API keys in /config/config.xml on first boot.
# This script waits for each container to produce its config, extracts the <ApiKey>,
# then waits for arr-dashboard to become healthy before writing all connection details
# into .env.services for Playwright to consume.
#
# Usage: cd e2e/integration && bash bootstrap-services.sh
#
# Supports both docker-compose v1 and docker compose v2.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.services"

# Timeout for waiting on config.xml (seconds)
CONFIG_TIMEOUT=120
# Timeout for dashboard health (seconds)
HEALTH_TIMEOUT=120
# Poll interval (seconds)
POLL_INTERVAL=3

# ── Helpers ────────────────────────────────────────────────────────────

log()  { echo "[bootstrap] $*"; }
fail() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }

# Extract <ApiKey> from a container's /config/config.xml
# Args: $1 = container name, $2 = timeout
extract_api_key() {
  local container="$1"
  local timeout="$2"
  local elapsed=0
  local api_key=""

  # All log/progress output goes to stderr so stdout is clean for the return value
  echo "[bootstrap] Waiting for ${container} config.xml (timeout: ${timeout}s)..." >&2

  while [ "$elapsed" -lt "$timeout" ]; do
    # Try to read config.xml from the container
    local config_xml
    config_xml=$(docker exec "$container" cat /config/config.xml 2>/dev/null || echo "")

    if [ -n "$config_xml" ]; then
      # Extract ApiKey using grep + sed (portable, no xmllint dependency)
      api_key=$(echo "$config_xml" | grep -oP '<ApiKey>\K[^<]+' 2>/dev/null || echo "")

      if [ -n "$api_key" ]; then
        echo "[bootstrap]   ${container}: API key extracted (${#api_key} chars)" >&2
        echo "$api_key"
        return 0
      fi
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    echo -n "." >&2
  done

  echo "" >&2
  fail "${container}: config.xml not found or missing <ApiKey> after ${timeout}s"
}

# Wait for a health endpoint to return status="ok"
# Args: $1 = URL, $2 = label, $3 = timeout
wait_for_health() {
  local url="$1"
  local label="$2"
  local timeout="$3"
  local elapsed=0

  log "Waiting for ${label} health at ${url} (timeout: ${timeout}s)..."

  while [ "$elapsed" -lt "$timeout" ]; do
    local response
    response=$(curl -sf "$url" 2>/dev/null || echo "")

    if [ -n "$response" ]; then
      local status
      status=$(echo "$response" | grep -oP '"status"\s*:\s*"\K[^"]+' 2>/dev/null || echo "")

      if [ "$status" = "ok" ]; then
        log "  ${label}: healthy!"
        return 0
      fi
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    echo -n "."
  done

  echo ""
  fail "${label}: not healthy after ${timeout}s"
}

# Wait for an HTTP endpoint to return a specific status code
# Args: $1 = URL, $2 = label, $3 = expected code, $4 = timeout, $5... = extra curl args
wait_for_http() {
  local url="$1"
  local label="$2"
  local expected_code="$3"
  local timeout="$4"
  shift 4
  local elapsed=0

  log "Waiting for ${label} at ${url} (expecting ${expected_code}, timeout: ${timeout}s)..."

  while [ "$elapsed" -lt "$timeout" ]; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "$@" "$url" 2>/dev/null || echo "000")

    if [ "$code" = "$expected_code" ]; then
      log "  ${label}: ready (HTTP ${code})"
      return 0
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "${label}: did not return HTTP ${expected_code} after ${timeout}s"
}

# ── Main ───────────────────────────────────────────────────────────────

log "=== Bootstrap Integration Services ==="
log ""

# 1. Extract API keys from each *arr container
SONARR_API_KEY=$(extract_api_key "e2e-sonarr" "$CONFIG_TIMEOUT")
RADARR_API_KEY=$(extract_api_key "e2e-radarr" "$CONFIG_TIMEOUT")
LIDARR_API_KEY=$(extract_api_key "e2e-lidarr" "$CONFIG_TIMEOUT")
READARR_API_KEY=$(extract_api_key "e2e-readarr" "$CONFIG_TIMEOUT")
PROWLARR_API_KEY=$(extract_api_key "e2e-prowlarr" "$CONFIG_TIMEOUT")

log ""

# 2. Create media directories inside *arr containers (required for root folder API)
log "Creating media directories in containers..."
docker exec e2e-sonarr mkdir -p /config/media/tv
docker exec e2e-sonarr chown -R abc:abc /config/media
docker exec e2e-radarr mkdir -p /config/media/movies
docker exec e2e-radarr chown -R abc:abc /config/media
docker exec e2e-lidarr mkdir -p /config/media/music
docker exec e2e-lidarr chown -R abc:abc /config/media
docker exec e2e-readarr mkdir -p /config/media/books
docker exec e2e-readarr chown -R abc:abc /config/media
log "  Media directories created"

log ""

# 3. Bootstrap Seerr
# Seerr starts pre-initialized via mounted settings.json (initialized=true,
# no media server required). We use the API key to configure services,
# create a test user, and submit pending requests.

SEERR_API_KEY="e2e-seerr-test-api-key-0123456789ab"
SEERR_URL="http://localhost:5055"

# 3a. Wait for Seerr to be ready
wait_for_http "$SEERR_URL/api/v1/status" "Seerr" "200" "$CONFIG_TIMEOUT" \
  -H "X-Api-Key: ${SEERR_API_KEY}"

# 3b. Connect Seerr to Radarr
log "Connecting Seerr to Radarr..."
curl -s -X POST "${SEERR_URL}/api/v1/settings/radarr" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${SEERR_API_KEY}" \
  -d "{\"name\":\"E2E Radarr\",\"hostname\":\"radarr\",\"port\":7878,\"apiKey\":\"${RADARR_API_KEY}\",\"useSsl\":false,\"baseUrl\":\"\",\"activeProfileId\":1,\"activeProfileName\":\"Any\",\"activeDirectory\":\"/config/media/movies\",\"is4k\":false,\"minimumAvailability\":\"released\",\"isDefault\":true}" \
  > /dev/null 2>&1 && log "  Radarr connected" || log "  WARN: Radarr connection failed"

# 3c. Create a non-admin local user for pending requests
# Seerr creates a local user when localLogin=true and no media server is required
log "Creating test requester..."
SEERR_TEST_USER=$(curl -s -X POST "${SEERR_URL}/api/v1/user" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${SEERR_API_KEY}" \
  -d '{"username":"e2e-requester","permissions":32}' 2>/dev/null || echo "")

SEERR_TEST_USER_ID=$(echo "$SEERR_TEST_USER" | grep -oP '"id":\K[0-9]+' 2>/dev/null || echo "")

if [ -n "$SEERR_TEST_USER_ID" ]; then
  log "  Test user created (id: ${SEERR_TEST_USER_ID})"
else
  log "  WARN: User creation returned: ${SEERR_TEST_USER:0:120}"
  SEERR_TEST_USER_ID=2
fi

# 3d. Submit pending requests
# Requests via API key with a userId for a non-admin user should stay pending
# if the user doesn't have auto-approve permissions
log "Creating pending requests..."

REQUEST_MOVIE=$(curl -s -X POST "${SEERR_URL}/api/v1/request" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${SEERR_API_KEY}" \
  -d "{\"mediaId\":550,\"mediaType\":\"movie\",\"userId\":${SEERR_TEST_USER_ID:-2}}" 2>/dev/null || echo "")
MOVIE_STATUS=$(echo "$REQUEST_MOVIE" | grep -oP '"status":\K[0-9]+' 2>/dev/null || echo "?")
log "  Movie request: status=${MOVIE_STATUS} (1=pending, 2=approved)"

REQUEST_TV=$(curl -s -X POST "${SEERR_URL}/api/v1/request" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${SEERR_API_KEY}" \
  -d "{\"mediaId\":2316,\"mediaType\":\"tv\",\"seasons\":[1],\"userId\":${SEERR_TEST_USER_ID:-2}}" 2>/dev/null || echo "")
TV_STATUS=$(echo "$REQUEST_TV" | grep -oP '"status":\K[0-9]+' 2>/dev/null || echo "?")
log "  TV request: status=${TV_STATUS} (1=pending, 2=approved)"

PENDING_COUNT=$(curl -s "${SEERR_URL}/api/v1/request/count" -H "X-Api-Key: ${SEERR_API_KEY}" 2>/dev/null | grep -oP '"pending":\K[0-9]+' || echo "0")
log "  Total pending: ${PENDING_COUNT}"

log ""

# 4. Wait for arr-dashboard to be healthy
wait_for_health "http://localhost:3000/health" "arr-dashboard (web)" "$HEALTH_TIMEOUT"
wait_for_health "http://localhost:3001/health" "arr-dashboard (api)" "$HEALTH_TIMEOUT"

log ""

# 4. Write .env.services
cat > "$ENV_FILE" << EOF
# Generated by bootstrap-services.sh — do not edit manually
# Internal URLs are used by arr-dashboard (inside Docker network)
# External URLs are used by Playwright/seed scripts (on the host)

# Sonarr
SONARR_API_KEY=${SONARR_API_KEY}
SONARR_URL=http://sonarr:8989
SONARR_EXTERNAL_URL=http://localhost:8989

# Radarr
RADARR_API_KEY=${RADARR_API_KEY}
RADARR_URL=http://radarr:7878
RADARR_EXTERNAL_URL=http://localhost:7878

# Lidarr
LIDARR_API_KEY=${LIDARR_API_KEY}
LIDARR_URL=http://lidarr:8686
LIDARR_EXTERNAL_URL=http://localhost:8686

# Readarr
READARR_API_KEY=${READARR_API_KEY}
READARR_URL=http://readarr:8787
READARR_EXTERNAL_URL=http://localhost:8787

# Prowlarr
PROWLARR_API_KEY=${PROWLARR_API_KEY}
PROWLARR_URL=http://prowlarr:9696
PROWLARR_EXTERNAL_URL=http://localhost:9696

# Dashboard
DASHBOARD_URL=http://localhost:3000
DASHBOARD_API_URL=http://localhost:3001

# Seerr
SEERR_API_KEY=${SEERR_API_KEY}
SEERR_URL=http://seerr:5055
SEERR_EXTERNAL_URL=http://localhost:5055
SEERR_TEST_USER_ID=${SEERR_TEST_USER_ID:-2}

# Webhook receiver (for notification testing)
WEBHOOK_RECEIVER_URL=http://webhook-receiver:80
WEBHOOK_RECEIVER_EXTERNAL_URL=http://localhost:9999
EOF

log "Wrote ${ENV_FILE}"
log ""
log "=== Bootstrap Complete ==="
log ""
log "Next: pnpm e2e:integration"
