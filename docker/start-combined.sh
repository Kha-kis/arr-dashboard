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

# Set ownership of writable directories using numeric IDs
# This ensures correct permissions even when mounting pre-existing directories
chown -R $PUID:$PGID /config

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

# Read settings as JSON from database (script is in api dir to access prisma client)
DB_SETTINGS=$(su-exec abc node /app/api/read-base-path.cjs 2>/dev/null || echo '{"apiPort":3001,"webPort":3000,"listenAddress":"0.0.0.0"}')

# Parse JSON values using node (since jq might not be available)
DB_API_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).apiPort||3001))")
DB_WEB_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).webPort||3000))")
DB_LISTEN_ADDRESS=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).listenAddress||'0.0.0.0'))")

# Use environment variables if set, otherwise use database values
# Environment variables take precedence over database settings
if [ -z "$API_PORT" ]; then
    export API_PORT="$DB_API_PORT"
fi

if [ -z "$PORT" ]; then
    export PORT="$DB_WEB_PORT"
fi

if [ -z "$HOST" ]; then
    export HOST="$DB_LISTEN_ADDRESS"
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
