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
# Start services (as abc user)
# ============================================

echo ""
echo "Starting API server on port 3001..."
cd /app/api
su-exec abc sh -c 'API_HOST=0.0.0.0 node dist/index.js' &
API_PID=$!
echo "API started with PID $API_PID"

# Give API a moment to start
sleep 2

echo ""
echo "Starting Web server on port 3000..."
cd /app/web
su-exec abc sh -c 'API_HOST=http://localhost:3001 node apps/web/server.js' &
WEB_PID=$!
echo "Web started with PID $WEB_PID"

echo ""
echo "=========================================="
echo "Arr Dashboard is ready!"
echo "Web UI: http://localhost:3000"
echo "API: http://localhost:3001"
echo "Running as UID:$PUID GID:$PGID"
echo "=========================================="

# Wait for both processes
wait $API_PID $WEB_PID

# If we get here, one of the processes died
echo "One of the services stopped unexpectedly"
exit 1
