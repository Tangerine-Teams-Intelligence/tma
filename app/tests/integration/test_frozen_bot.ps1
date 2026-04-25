# Integration test: frozen Discord bot binary launches and responds to --help.

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$Exe = Join-Path $RepoRoot "app\resources\bot\tangerine-meeting-bot.exe"

if (-not (Test-Path $Exe)) {
  Write-Error "Frozen bot missing at $Exe — run scripts\build_bot.ps1 first."
  exit 1
}

$out = & $Exe --help 2>&1
$exit = $LASTEXITCODE
Write-Host "Exit: $exit"
Write-Host ($out | Out-String)

# pkg-bundled CLIs commonly exit 0 or 1 on --help depending on argv parser.
if ($exit -gt 1) {
  Write-Error "Bot --help returned unexpected exit: $exit"
  exit $exit
}

Write-Host "test_frozen_bot.ps1 PASS"
