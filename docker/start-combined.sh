#!/bin/sh
set -e

echo "=========================================="
echo "Arr Dashboard - Combined Container"
echo "=========================================="

# ============================================
# PUID/PGID handling (LinuxServer convention)
# ============================================

PUID=${PUID:-911}
PGID=${PGID:-911}

echo ""
echo "Setting up user/group..."
echo "  - PUID: $PUID"
echo "  - PGID: $PGID"

# Modify abc group GID if different from default
if [ "$(id -g abc)" != "$PGID" ]; then
    groupmod -o -g "$PGID" abc
fi

# Modify abc user UID if different from default
if [ "$(id -u abc)" != "$PUID" ]; then
    usermod -o -u "$PUID" abc
fi

# ============================================
# Directory setup and permissions
# ============================================

echo ""
echo "Setting up directories and permissions..."

# Ensure config directory exists (LinuxServer convention)
mkdir -p /config

# Validate PUID/PGID are numeric (defense-in-depth)
case "$PUID" in
	''|*[!0-9]*) echo "Invalid PUID: $PUID (must be numeric)" >&2; exit 1 ;;
esac
case "$PGID" in
	''|*[!0-9]*) echo "Invalid PGID: $PGID (must be numeric)" >&2; exit 1 ;;
esac

# Set ownership of writable directories using numeric IDs
# This ensures correct permissions even when mounting pre-existing directories
chown -R "${PUID}:${PGID}" /config

# NOTE: We intentionally do NOT chown /app/api recursively here.
# A recursive chown on /app/api (~40k+ files in node_modules) causes severe
# performance issues on Unraid's FUSE-based filesystem (shfs), creating
# startup hangs that can last several minutes or indefinitely.
# See: https://github.com/Kha-kis/arr-dashboard/issues/29
#
# Instead, we only set permissions on specific Prisma directories when
# a database provider switch actually requires client regeneration (below).

# ============================================
# Signal handling
# ============================================

shutdown() {
    echo ""
    echo "Shutting down services..."

    # Send SIGTERM to both processes
    if [ -n "$WEB_PID" ]; then
        kill -TERM "$WEB_PID" 2>/dev/null || true
    fi
    if [ -n "$API_PID" ]; then
        kill -TERM "$API_PID" 2>/dev/null || true
    fi

    # Wait for processes to finish
    wait

    echo "Services stopped gracefully"
    exit 0
}

trap shutdown SIGTERM SIGINT

# ============================================
# Database provider detection and Prisma setup
# ============================================

echo ""
echo "Detecting database type..."
cd /app/api

# Default DATABASE_URL to SQLite if not set or empty
# This handles cases where Unraid template sets DATABASE_URL="" which overrides Dockerfile default
if [ -z "$DATABASE_URL" ]; then
    export DATABASE_URL="file:/config/prod.db"
    echo "  - DATABASE_URL not set, defaulting to SQLite: $DATABASE_URL"
fi

# Detect if DATABASE_URL is PostgreSQL
if echo "$DATABASE_URL" | grep -qE "^postgres(ql)?://"; then
    echo "  - PostgreSQL database detected"
    DB_PROVIDER="postgresql"
else
    echo "  - SQLite database detected"
    DB_PROVIDER="sqlite"
fi

# Check current datasource provider in schema (not the generator provider)
# Look for provider inside datasource block specifically
CURRENT_PROVIDER=$(grep -A2 'datasource db' prisma/schema.prisma | grep 'provider' | sed 's/.*provider = "\([^"]*\)".*/\1/')

echo "  - Current schema provider: $CURRENT_PROVIDER"
echo "  - Required provider: $DB_PROVIDER"

# If provider needs to change, update schema and regenerate client
if [ "$CURRENT_PROVIDER" != "$DB_PROVIDER" ]; then
    echo "  - Switching Prisma datasource provider from $CURRENT_PROVIDER to $DB_PROVIDER..."

    # Update only the datasource provider in schema.prisma (not the generator)
    # Use a more robust sed pattern that handles different formatting
    if ! sed -i '/datasource db/,/^}/ s/provider = "[^"]*"/provider = "'"$DB_PROVIDER"'"/' prisma/schema.prisma; then
        echo "ERROR: Failed to update schema.prisma provider" >&2
        exit 1
    fi

    # Verify the change was applied
    NEW_PROVIDER=$(grep -A2 'datasource db' prisma/schema.prisma | grep 'provider' | sed 's/.*provider = "\([^"]*\)".*/\1/')
    if [ "$NEW_PROVIDER" != "$DB_PROVIDER" ]; then
        echo "ERROR: Schema provider update failed. Expected '$DB_PROVIDER' but got '$NEW_PROVIDER'" >&2
        echo "  This may happen if the schema.prisma format is non-standard." >&2
        exit 1
    fi
    echo "  - Schema updated successfully"

    # Regenerate Prisma client for new provider
    echo "  - Regenerating Prisma client (this may take a moment)..."

    # Set permissions ONLY on the specific Prisma client directories that need to be writable
    # This is much faster than chown -R /app/api which causes Unraid startup hangs
    # See: https://github.com/Kha-kis/arr-dashboard/issues/29
    echo "  - Setting permissions for Prisma client directories..."
    for dir in /app/api/node_modules/.pnpm/@prisma+client@*/; do
        [ -d "$dir" ] && chown -R "${PUID}:${PGID}" "$dir"
    done
    # Also handle the top-level @prisma directory symlinks
    [ -d "/app/api/node_modules/@prisma" ] && chown -R "${PUID}:${PGID}" "/app/api/node_modules/@prisma"
    # Ensure prisma directory is writable for any generated files
    [ -d "/app/api/node_modules/.prisma" ] && chown -R "${PUID}:${PGID}" "/app/api/node_modules/.prisma"

    if ! su-exec abc ./node_modules/.bin/prisma generate --schema prisma/schema.prisma; then
        echo "ERROR: Failed to regenerate Prisma client" >&2
        echo "  Check that /app/api has correct permissions for PUID:$PUID PGID:$PGID" >&2
        exit 1
    fi

    echo "  - Provider switched successfully"
else
    echo "  - Prisma provider already set to $DB_PROVIDER (no change needed)"
fi

# ============================================
# Database schema synchronization (run as abc user)
# ============================================

echo ""
echo "Synchronizing database schema..."
# Use 'db push' instead of 'migrate deploy' to support multi-provider (SQLite/PostgreSQL)
# Prisma migrations are provider-specific SQL, but db push generates correct SQL for any provider
# --accept-data-loss allows dropping unused columns during schema updates (e.g., removed urlBase)
# Note: Prisma 7 removed --skip-generate flag (db push no longer regenerates by default)
if ! su-exec abc ./node_modules/.bin/prisma db push --schema prisma/schema.prisma --accept-data-loss; then
    echo "ERROR: Database schema synchronization failed" >&2
    echo "  - Ensure DATABASE_URL is correct and the database is accessible" >&2
    echo "  - For PostgreSQL: Check that the database exists and user has permissions" >&2
    echo "  - Current DATABASE_URL: ${DATABASE_URL%%@*}@[REDACTED]" >&2
    exit 1
fi
echo "  - Database schema synchronized successfully"

# ============================================
# Read system settings from database
# ============================================

echo ""
echo "Loading system settings from database..."

# Read settings as JSON from database (script is in api dir to access prisma client)
DB_SETTINGS=$(su-exec abc node /app/api/read-base-path.cjs 2>/dev/null || echo '{"apiPort":null,"webPort":null,"listenAddress":null}')

# Parse JSON values using node (since jq might not be available)
DB_API_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).apiPort;console.log(v||'')})")
DB_WEB_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).webPort;console.log(v||'')})")
DB_LISTEN_ADDRESS=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).listenAddress;console.log(v||'')})")

# Priority: Database settings > Environment variables > Defaults
# Database settings take precedence because users configure them via the UI
# Environment variables are typically Dockerfile defaults, not user-configured
if [ -n "$DB_API_PORT" ]; then
    export API_PORT="$DB_API_PORT"
elif [ -z "$API_PORT" ]; then
    export API_PORT="3001"
fi

if [ -n "$DB_WEB_PORT" ]; then
    export PORT="$DB_WEB_PORT"
elif [ -z "$PORT" ]; then
    export PORT="3000"
fi

if [ -n "$DB_LISTEN_ADDRESS" ]; then
    export HOST="$DB_LISTEN_ADDRESS"
elif [ -z "$HOST" ]; then
    export HOST="0.0.0.0"
fi

echo "  - Listen Address: $HOST"
echo "  - API Port: $API_PORT"
echo "  - Web Port: $PORT"

# ============================================
# Start API server (as abc user)
# ============================================

echo ""
echo "Starting API server on $HOST:$API_PORT..."
cd /app/api
su-exec abc sh -c "API_HOST=$HOST API_PORT=$API_PORT HOST=$HOST node dist/index.js" &
API_PID=$!
echo "API started with PID $API_PID"

# Give API a moment to start
sleep 2

# ============================================
# Start Web server (as abc user)
# ============================================

echo ""
echo "Starting Web server on $HOST:$PORT..."
cd /app/web
# Use custom server wrapper for runtime API_HOST configuration
su-exec abc sh -c "API_HOST=http://localhost:$API_PORT PORT=$PORT HOSTNAME=$HOST HOST=$HOST node server.js" &
WEB_PID=$!
echo "Web started with PID $WEB_PID"

echo ""
echo "=========================================="
echo "Arr Dashboard is ready!"
echo "Web UI: http://localhost:$PORT"
echo "API: http://localhost:$API_PORT"
echo "Running as UID:$PUID GID:$PGID"
echo "=========================================="

# Wait for both processes
wait $API_PID $WEB_PID

# If we get here, one of the processes died
echo "One of the services stopped unexpectedly"
exit 1
