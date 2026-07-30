$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Aiko"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Aiko"
$desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "Aiko.lnk"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Aiko"

Get-Process "aiko-desktop", "aiko" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse $startMenuDir -ErrorAction SilentlyContinue
Remove-Item -Force $desktopLink -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse $uninstallKey -ErrorAction SilentlyContinue

# Keep ~/.aiko: it contains the user's shared CLI/desktop login and data.
$self = $MyInvocation.MyCommand.Path
$cleanup = "Start-Sleep -Milliseconds 500; Remove-Item -Force -Recurse `"$installDir`" -ErrorAction SilentlyContinue"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $cleanup
Write-Host "Aiko was removed. Your login and user data in %USERPROFILE%\.aiko were preserved."
