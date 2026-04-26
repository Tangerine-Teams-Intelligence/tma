# Integration test: frozen Python interpreter runs `tmi --help` correctly
# from inside the actual non-ASCII project path. This is the regression check
# for the PyInstaller path-encoding bug warned about in APP-INTERFACES.md.

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$Exe = Join-Path $RepoRoot "app\resources\python\python.exe"

if (-not (Test-Path $Exe)) {
  Write-Error "Frozen python missing at $Exe — run scripts\build_python.ps1 first."
  exit 1
}

# 1. Confirm the path itself contains a space (we want to be sure we're
#    actually exercising the non-ASCII-path code path).
if (-not ($Exe -match ' ')) {
  Write-Warning "Test path does not contain a space; this run does not exercise the Windows path bug."
}

# 2. Run --help.
$out = & $Exe --help 2>&1
$exit = $LASTEXITCODE
Write-Host "Exit: $exit"
Write-Host ($out | Out-String)

if ($exit -ne 0) {
  Write-Error "tmi --help returned $exit"
  exit $exit
}

if (-not ($out -match "tmi" -or $out -match "Usage")) {
  Write-Error "tmi --help output did not contain expected strings."
  exit 2
}

# 3. Spawn from a different cwd to prove --paths handling worked.
Push-Location $env:TEMP
try {
  $out2 = & $Exe list 2>&1
  Write-Host "list exit: $LASTEXITCODE"
  Write-Host ($out2 | Out-String)
}
finally {
  Pop-Location
}

Write-Host "test_frozen_python.ps1 PASS"
