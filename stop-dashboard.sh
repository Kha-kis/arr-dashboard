#!/bin/bash

# *arr Dashboard Stop Script for Linux/macOS
# This script stops the dashboard

echo "🛑 Stopping *arr Dashboard..."

# Stop by PID file if it exists
if [ -f dashboard.pid ]; then
    PID=$(cat dashboard.pid)
    if kill -0 $PID 2>/dev/null; then
        echo "📋 Stopping process $PID..."
        kill $PID
        sleep 2
        
        # Force kill if still running
        if kill -0 $PID 2>/dev/null; then
            echo "🔨 Force stopping process $PID..."
            kill -9 $PID
        fi
    fi
    rm -f dashboard.pid
fi

# Kill any remaining Node.js processes on port 3000
if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti:3000 2>/dev/null)
    if [ ! -z "$PIDS" ]; then
        echo "🔨 Killing processes using port 3000: $PIDS"
        echo $PIDS | xargs -r kill -9
    fi
fi

# Alternative method using netstat and kill
if command -v netstat >/dev/null 2>&1; then
    PID=$(netstat -tlnp 2>/dev/null | grep :3000 | awk '{print $7}' | cut -d/ -f1 | head -n1)
    if [ ! -z "$PID" ] && [ "$PID" != "-" ]; then
        echo "🔨 Killing process $PID using port 3000..."
        kill -9 $PID 2>/dev/null
    fi
fi

# Kill any node processes with server/index.js
pkill -f "node.*server/index.js" 2>/dev/null

# Wait and verify
sleep 2

# Check if port is now free
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Some processes may still be running on port 3000"
    echo "🔍 Check manually: lsof -i :3000"
else
    echo "✅ *arr Dashboard stopped successfully"
fi

# Clean up log file if it's empty or you want to reset it
# rm -f dashboard.log