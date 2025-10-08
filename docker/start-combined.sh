#!/bin/sh
set -e

echo "=========================================="
echo "Arr Dashboard - Combined Container"
echo "=========================================="

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
trap shutdown SIGTERM SIGINT

echo ""
echo "Running database migrations..."
cd /app/api
npx prisma migrate deploy --schema prisma/schema.prisma

echo ""
echo "Starting API server on port 3001..."
cd /app/api
# API server needs API_HOST=0.0.0.0 for binding
API_HOST=0.0.0.0 node dist/index.js &
API_PID=$!
echo "API started with PID $API_PID"

# Give API a moment to start
sleep 2

echo ""
echo "Starting Web server on port 3000..."
cd /app/web
# Web server needs API_HOST=http://localhost:3001 for proxying
API_HOST=http://localhost:3001 node apps/web/server.js &
WEB_PID=$!
echo "Web started with PID $WEB_PID"

echo ""
echo "=========================================="
echo "Arr Dashboard is ready!"
echo "Web UI: http://localhost:3000"
echo "API: http://localhost:3001"
echo "=========================================="

# Wait for both processes
wait $API_PID $WEB_PID

# If we get here, one of the processes died
echo "One of the services stopped unexpectedly"
exit 1
