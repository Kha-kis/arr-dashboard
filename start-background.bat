@echo off
echo 🚀 Starting *arr Dashboard in background...

REM Build the production version
call npm run build

REM Start the server in background (no window)
start "*arr Dashboard" /MIN cmd /c "npm run server:prod"

REM Wait a moment for server to start
ping 127.0.0.1 -n 4 > nul

REM Check if it's running
powershell -Command "try { $response = Invoke-WebRequest -Uri 'http://localhost:3000/api/health' -UseBasicParsing; if ($response.StatusCode -eq 200) { Write-Host '✅ *arr Dashboard is running successfully!' -ForegroundColor Green; Write-Host '🌐 Access at: http://localhost:3000' -ForegroundColor Cyan } } catch { Write-Host '❌ Failed to start. Check for errors.' -ForegroundColor Red }"

echo.
echo 🛠️  To stop: run stop-dashboard.bat
pause