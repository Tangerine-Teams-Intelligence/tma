# Orchestrate the full v1.5 release build: Python + bot + Tauri.

$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot

Write-Host "===== build_all.ps1 ====="
& "$Here\build_python.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& "$Here\build_bot.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Tauri build last; resources/ must already be populated for the bundle.
$AppDir = Resolve-Path "$Here\.."
Push-Location $AppDir
try {
  Write-Host "Running: npm run tauri build"
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}

Write-Host "===== build_all.ps1 done ====="
