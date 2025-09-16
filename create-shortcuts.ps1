$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ProjectPath = $PSScriptRoot

$StartShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$DesktopPath\Start arr Dashboard.lnk")
$StartShortcut.TargetPath = "$ProjectPath\start-background.bat"
$StartShortcut.WorkingDirectory = $ProjectPath
$StartShortcut.IconLocation = "shell32.dll,137"
$StartShortcut.Description = "Start *arr Dashboard in background"
$StartShortcut.Save()

$StopShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$DesktopPath\Stop arr Dashboard.lnk")
$StopShortcut.TargetPath = "$ProjectPath\stop-dashboard.bat"
$StopShortcut.WorkingDirectory = $ProjectPath
$StopShortcut.IconLocation = "shell32.dll,131"
$StopShortcut.Description = "Stop *arr Dashboard"
$StopShortcut.Save()

$OpenShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$DesktopPath\Open arr Dashboard.lnk")
$OpenShortcut.TargetPath = "http://localhost:3000"
$OpenShortcut.IconLocation = "shell32.dll,14"
$OpenShortcut.Description = "Open *arr Dashboard in browser"
$OpenShortcut.Save()

Write-Host "Desktop shortcuts created successfully!" -ForegroundColor Green
Write-Host "You can now start/stop the dashboard from your desktop" -ForegroundColor Cyan
