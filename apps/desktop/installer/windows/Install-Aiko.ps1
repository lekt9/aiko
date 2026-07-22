param(
  [switch]$NoDesktopShortcut,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $source "payload"
$desktopExe = Join-Path $payload "aiko-desktop.exe"
$runtimeExe = Join-Path $payload "aiko.exe"
$contractDll = Join-Path $payload "contract.dll"

if (-not (Test-Path $desktopExe) -or -not (Test-Path $runtimeExe) -or -not (Test-Path $contractDll)) {
  throw "The Aiko installer payload is incomplete. Keep the payload folder beside this script."
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\Aiko"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Aiko"
$desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "Aiko.lnk"
$startMenuLink = Join-Path $startMenuDir "Aiko.lnk"
$uninstallLink = Join-Path $startMenuDir "Uninstall Aiko.lnk"

New-Item -ItemType Directory -Force -Path $installDir, $startMenuDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir "contract") | Out-Null
Copy-Item -Force $desktopExe (Join-Path $installDir "aiko-desktop.exe")
Copy-Item -Force $runtimeExe (Join-Path $installDir "aiko.exe")
Copy-Item -Force $contractDll (Join-Path $installDir "contract\contract.dll")
Copy-Item -Force (Join-Path $source "Uninstall-Aiko.ps1") (Join-Path $installDir "Uninstall-Aiko.ps1")

$shell = New-Object -ComObject WScript.Shell
function New-AikoShortcut([string]$path, [string]$target, [string]$arguments = "") {
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $target
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$target,0"
  $shortcut.Save()
}

$installedApp = Join-Path $installDir "aiko-desktop.exe"
New-AikoShortcut $startMenuLink $installedApp
New-AikoShortcut $uninstallLink "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$installDir\Uninstall-Aiko.ps1`""
if (-not $NoDesktopShortcut) {
  New-AikoShortcut $desktopLink $installedApp
}

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Aiko"
New-Item -Force $uninstallKey | Out-Null
New-ItemProperty -Force $uninstallKey DisplayName "Aiko" | Out-Null
New-ItemProperty -Force $uninstallKey DisplayVersion "0.1.0" | Out-Null
New-ItemProperty -Force $uninstallKey Publisher "Aiko" | Out-Null
New-ItemProperty -Force $uninstallKey InstallLocation $installDir | Out-Null
New-ItemProperty -Force $uninstallKey DisplayIcon $installedApp | Out-Null
New-ItemProperty -Force $uninstallKey UninstallString "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$installDir\Uninstall-Aiko.ps1`"" | Out-Null
New-ItemProperty -Force -PropertyType DWord $uninstallKey NoModify 1 | Out-Null
New-ItemProperty -Force -PropertyType DWord $uninstallKey NoRepair 1 | Out-Null

Write-Host "Aiko was installed to $installDir"
Write-Host "Your existing Aiko login remains in %USERPROFILE%\.aiko and is reused automatically."
if (-not $NoLaunch) {
  Start-Process $installedApp
}
