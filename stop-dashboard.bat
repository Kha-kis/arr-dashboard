@echo off
echo 🛑 Stopping *arr Dashboard...

REM Kill any Node.js processes running arr dashboard
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo table /nh 2^>nul') do (
    taskkill /f /pid %%a >nul 2>&1
)

REM Kill any processes using port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000') do (
    if not "%%a"=="0" (
        taskkill /f /pid %%a >nul 2>&1
    )
)

REM Double check with PowerShell
powershell -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>&1

ping 127.0.0.1 -n 3 >nul

REM Verify it's stopped
netstat -ano | findstr :3000 >nul
if %errorlevel% equ 0 (
    echo ⚠️  Some processes may still be running. Try running this script again.
) else (
    echo ✅ *arr Dashboard stopped successfully.
)
pause
