# Integration test: bot directory bundle is well-formed and `node dist/index.js`
# launches successfully. (Path D — pkg replaced with directory bundle, bot runs
# on user-supplied Node 20+; see scripts/build_bot.ps1.)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$BotDir   = Join-Path $RepoRoot "app\resources\bot"
$Entry    = Join-Path $BotDir "dist\index.js"
$NodeMods = Join-Path $BotDir "node_modules"
$PkgJson  = Join-Path $BotDir "package.json"

foreach ($p in @($Entry, $NodeMods, $PkgJson)) {
  if (-not (Test-Path $p)) {
    Write-Error "Bot bundle missing required path: $p — run scripts\build_bot.ps1 first."
    exit 1
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found on PATH (Path D requires Node 20+)."
  exit 1
}

$out = & node $Entry --help 2>&1
$exit = $LASTEXITCODE
Write-Host "Exit: $exit"
Write-Host ($out | Out-String)

# Bot CLIs commonly exit 0 or 1 on --help depending on argv parser.
if ($exit -gt 1) {
  Write-Error "Bot --help returned unexpected exit: $exit"
  exit $exit
}

Write-Host "test_frozen_bot.ps1 PASS"
