#!/bin/bash

# *arr Dashboard Start Script for Linux/macOS
# This script starts the dashboard in the background

echo "🚀 Starting *arr Dashboard in background..."

# Build the production version
npm run build

# Check if port 3000 is already in use
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 3000 is already in use. Stopping existing process..."
    ./stop-dashboard.sh
    sleep 2
fi

# Start the server in background
nohup npm run server:prod > dashboard.log 2>&1 &
SERVER_PID=$!

# Wait a moment for server to start
sleep 3

# Check if it's running
if curl -s http://localhost:3000/api/health >/dev/null 2>&1; then
    echo "✅ *arr Dashboard is running successfully!"
    echo "🌐 Access at: http://localhost:3000"
    echo "📋 Process ID: $SERVER_PID"
    echo "$SERVER_PID" > dashboard.pid
else
    echo "❌ Failed to start. Check dashboard.log for errors."
    exit 1
fi

echo ""
echo "🛠️  To stop: ./stop-dashboard.sh"
echo "📄 Logs: tail -f dashboard.log"