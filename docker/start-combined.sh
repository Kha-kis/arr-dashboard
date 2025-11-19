#!/bin/sh
set -e

echo "=========================================="
echo "Arr Dashboard - Combined Container"
echo "=========================================="

# ===== PUID/PGID HANDLING =====
# Default PUID/PGID to 1000:1000 if not set
PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Configured to run as UID:GID = $PUID:$PGID"

# If running as root (UID 0), we need to change ownership and drop privileges
if [ "$(id -u)" = "0" ]; then
    echo "Running as root, will drop privileges to $PUID:$PGID"
    
    # Update the arruser UID/GID to match requested values
    if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
        echo "Updating arruser to UID:GID = $PUID:$PGID"

        # Modify group first - always create appgroup to ensure it exists
        delgroup nodejs 2>/dev/null || true
        addgroup -g "$PGID" appgroup 2>/dev/null || true

        # Modify user
        if [ "$PUID" != "1000" ]; then
            deluser arruser 2>/dev/null || true
            adduser -D -u "$PUID" -G appgroup arruser 2>/dev/null || true
        fi
    fi
    
    # Ensure data directory exists and set permissions
    echo ""
    echo "Setting permissions on /app/data..."
    mkdir -p /app/data
    chown -R "$PUID:$PGID" /app/data
    
    # Check if we can write to data directory
    if ! su-exec "$PUID:$PGID" test -w /app/data; then
        echo "WARNING: /app/data is not writable for UID:GID $PUID:$PGID"
        echo "Please check your volume mount permissions"
    else
        echo "✓ Data directory is writable"
    fi
    
    echo ""
    echo "Switching to user $PUID:$PGID..."
    # Use su-exec to drop privileges and continue with the rest of this script
    exec su-exec "$PUID:$PGID" "$0" "--as-user"
fi

# ===== Check if restarted as non-root user =====
if [ "$1" = "--as-user" ]; then
    shift  # Remove the --as-user flag
    echo "✓ Now running as UID=$(id -u), GID=$(id -g)"
fi

# ===== GRACEFUL SHUTDOWN HANDLER =====
# Function to handle shutdown gracefully
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

# Trap signals
trap shutdown TERM INT

# ===== PERMISSIONS CHECK (if running as non-root from the start) =====
if [ "$(id -u)" != "0" ]; then
    echo ""
    echo "Ensuring data directory permissions..."
    mkdir -p /app/data
    
    # Try to create a test file to check permissions
    if ! touch /app/data/.permissions_test 2>/dev/null; then
        echo "WARNING: /app/data is not writable. Database operations may fail."
        echo "Please ensure the mounted volume has proper permissions for UID $(id -u)."
    else
        rm -f /app/data/.permissions_test
        echo "✓ Data directory is writable"
    fi
fi

# ===== DATABASE MIGRATIONS =====
echo ""
echo "Running database migrations..."
cd /app/api
npx prisma migrate deploy --schema prisma/schema.prisma

# ===== START API SERVER =====
echo ""
echo "Starting API server on port 3001..."
cd /app/api
# API server needs API_HOST=0.0.0.0 for binding
API_HOST=0.0.0.0 node dist/index.js &
API_PID=$!
echo "✓ API started with PID $API_PID"

# Give API a moment to start
sleep 2

# ===== START WEB SERVER =====
echo ""
echo "Starting Web server on port 3000..."
cd /app/web
# Web server needs API_HOST=http://localhost:3001 for proxying
API_HOST=http://localhost:3001 node apps/web/server.js &
WEB_PID=$!
echo "✓ Web started with PID $WEB_PID"

echo ""
echo "=========================================="
echo "Arr Dashboard is ready!"
echo "Web UI: http://localhost:3000"
echo "API: http://localhost:3001"
echo "Running as UID:GID = $(id -u):$(id -g)"
echo "=========================================="

# Wait for both processes
wait $API_PID $WEB_PID

# If we get here, one of the processes died
echo "One of the services stopped unexpectedly"
exit 1
