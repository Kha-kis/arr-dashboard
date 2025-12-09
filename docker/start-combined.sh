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

# Set ownership of writable directories
chown -R abc:abc /config

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
# Database migrations (run as abc user)
# ============================================

echo ""
echo "Running database migrations..."
cd /app/api
su-exec abc npx prisma migrate deploy --schema prisma/schema.prisma

# ============================================
# Read system settings from database
# ============================================

echo ""
echo "Loading system settings from database..."

# Read settings as JSON from database
DB_SETTINGS=$(su-exec abc node /app/read-base-path.js 2>/dev/null || echo '{"urlBase":"","apiPort":3001,"webPort":3000}')

# Parse JSON values using node (since jq might not be available)
DB_URL_BASE=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).urlBase||''))")
DB_API_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).apiPort||3001))")
DB_WEB_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).webPort||3000))")

# Use environment variables if set, otherwise use database values
# Environment variables take precedence over database settings
if [ -z "$BASE_PATH" ]; then
    export BASE_PATH="$DB_URL_BASE"
fi

if [ -z "$API_PORT" ]; then
    export API_PORT="$DB_API_PORT"
fi

if [ -z "$PORT" ]; then
    export PORT="$DB_WEB_PORT"
fi

echo "  - URL Base: ${BASE_PATH:-(root)}"
echo "  - API Port: $API_PORT"
echo "  - Web Port: $PORT"

# ============================================
# Start API server (as abc user)
# ============================================

echo ""
echo "Starting API server on port $API_PORT..."
cd /app/api
su-exec abc sh -c "API_HOST=0.0.0.0 API_PORT=$API_PORT node dist/index.js" &
API_PID=$!
echo "API started with PID $API_PID"

# Give API a moment to start
sleep 2

# ============================================
# Start Web server (as abc user)
# ============================================

echo ""
echo "Starting Web server on port $PORT..."
cd /app/web
su-exec abc sh -c "API_HOST=http://localhost:$API_PORT BASE_PATH='$BASE_PATH' PORT=$PORT HOSTNAME=0.0.0.0 node apps/web/server.js" &
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
