# Build the frozen Discord bot single-file executable.
# Output: app\resources\bot\tangerine-meeting-bot.exe  (via `pkg`)
#
# Same non-ASCII-path mitigation as build_python.ps1: pkg writes its temp
# snapshot under %LOCALAPPDATA%\pkg-cache, which is fine, but the input
# project path can confuse pkg's path-string handling on Windows. We resolve
# the bot project through a short symlink in $env:TEMP if the repo path
# contains characters outside [A-Za-z0-9_\-]. That's belt-and-braces; remove
# once pkg ships a fix.
#
# Requires: Node 20+, npm, pkg (`npm install -g pkg`).

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$AppDir   = Join-Path $RepoRoot "app"
$BotDir   = Join-Path $RepoRoot "bot"
$OutDir   = Join-Path $AppDir "resources\bot"
$OutExe   = Join-Path $OutDir "tangerine-meeting-bot.exe"

Write-Host "===== build_bot.ps1 ====="
Write-Host "Repo root : $RepoRoot"
Write-Host "Bot dir   : $BotDir"
Write-Host "Out exe   : $OutExe"

# 1. Preflight.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found on PATH"
  exit 1
}
# `Get-Command pkg` misses .cmd shims under %APPDATA%\npm in PS 5.1, so probe
# explicit candidates first.
$pkgCmd = $null
$candidates = @(
  (Get-Command pkg.cmd -ErrorAction SilentlyContinue),
  (Get-Command pkg     -ErrorAction SilentlyContinue)
)
foreach ($c in $candidates) {
  if ($c) { $pkgCmd = $c; break }
}
if (-not $pkgCmd) {
  $explicit = Join-Path $env:APPDATA "npm\pkg.cmd"
  if (Test-Path $explicit) { $pkgCmd = @{ Source = $explicit } }
}
if (-not $pkgCmd) {
  Write-Error "pkg not found. Install with: npm install -g pkg"
  exit 1
}

# 2. Compile TypeScript first (pkg consumes JS).
Push-Location $BotDir
try {
  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing bot dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Write-Host "Building TypeScript..."
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}

# 3. Optional: re-mount via short symlink if path contains spaces or non-ASCII.
$needsLink = $BotDir -match '[^A-Za-z0-9_\-\\:]'
$EffectiveBotDir = $BotDir
if ($needsLink) {
  $LinkRoot = Join-Path $env:TEMP "tmi-bot-link"
  Remove-Item -Recurse -Force $LinkRoot -ErrorAction SilentlyContinue | Out-Null
  Write-Host "Path contains non-ASCII or space; staging via $LinkRoot"
  # Use a directory junction (works without admin).
  cmd.exe /c "mklink /J `"$LinkRoot`" `"$BotDir`"" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "mklink failed; falling back to robocopy stage."
    New-Item -ItemType Directory -Path $LinkRoot | Out-Null
    # Direct & invocation (Start-Process drops quoting around spaces — see
    # build_python.ps1 for the full bug story).
    & robocopy.exe $BotDir $LinkRoot /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
    & robocopy.exe (Join-Path $BotDir "node_modules") (Join-Path $LinkRoot "node_modules") /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  $EffectiveBotDir = $LinkRoot
}

# 4. Run pkg.
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Path $OutDir | Out-Null

Push-Location $EffectiveBotDir
try {
  $entry = Join-Path $EffectiveBotDir "dist\index.js"
  if (-not (Test-Path $entry)) {
    Write-Error "Bot entry missing: $entry  (did `npm run build` succeed?)"
    exit 2
  }
  $pkgArgs = @(
    $entry,
    "--targets", "node20-win-x64",
    "--output", $OutExe,
    "--compress", "GZip"
  )
  Write-Host "Running: pkg $($pkgArgs -join ' ')"
  & $pkgCmd.Source @pkgArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Error "pkg failed with $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path $OutExe)) {
  Write-Error "Expected bot exe missing at $OutExe"
  exit 3
}

# 5. Smoke test.
Write-Host "Smoke testing $OutExe ..."
$smokeOutput = & $OutExe "--help" 2>&1
$exit = $LASTEXITCODE
if ($exit -ne 0 -and $exit -ne 1) {
  # Many CLIs return non-zero on --help; only flag if it crashed hard.
  Write-Warning "Smoke test unusual exit: $exit"
  Write-Warning ($smokeOutput | Out-String)
} else {
  Write-Host "Smoke test OK (exit $exit)."
}

$sizeMB = [math]::Round((Get-Item $OutExe).Length / 1MB, 1)
Write-Host "Bot bundle size: $sizeMB MB"
Write-Host "===== build_bot.ps1 done ====="
