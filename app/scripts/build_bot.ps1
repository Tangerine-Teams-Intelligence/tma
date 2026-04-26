# build_bot.ps1 — Path D: directory bundle, no pkg.
#
# pkg@5.8.1 is unmaintained (since 2023-08) and does not support Node 20+. We
# instead ship the compiled bot as a Tauri resource directory:
#   resources/bot/dist/index.js
#   resources/bot/node_modules/...
#   resources/bot/package.json
# At runtime, the Rust runner spawns `node dist/index.js` from this dir, using
# the user's existing Node 20+ on PATH (same prerequisite model as the user's
# existing Claude Code subscription — we don't bundle either).

$ErrorActionPreference = "Stop"

$RepoRoot        = (Resolve-Path "$PSScriptRoot\..\..").Path
$BotDir          = Join-Path $RepoRoot "bot"
$BotResourceDir  = Join-Path $RepoRoot "app\resources\bot"

Write-Host "===== build_bot.ps1 (Path D - directory bundle) ====="
Write-Host "Repo root  : $RepoRoot"
Write-Host "Bot dir    : $BotDir"
Write-Host "Out dir    : $BotResourceDir"

# 1. Preflight
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node not found on PATH"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found on PATH"
}

# 2. TypeScript build (assumes deps already installed in CI; install if not)
Push-Location $BotDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "Installing bot dependencies (initial)..."
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    Write-Host "Building TypeScript..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally {
    Pop-Location
}

# 3. Clean + recreate output dir
if (Test-Path $BotResourceDir) {
    Remove-Item $BotResourceDir -Recurse -Force
}
New-Item -ItemType Directory -Path $BotResourceDir -Force | Out-Null

# 4. Copy compiled JS
Copy-Item -Path "$BotDir\dist" -Destination "$BotResourceDir\dist" -Recurse -Force

# 5. Reinstall as production-only to keep bundle smaller, then copy node_modules
Push-Location $BotDir
try {
    Write-Host "Installing production-only deps for bundle..."
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed" }
}
finally {
    Pop-Location
}

Copy-Item -Path "$BotDir\node_modules" -Destination "$BotResourceDir\node_modules" -Recurse -Force

# 6. Copy package.json so Node can resolve modules at runtime
Copy-Item -Path "$BotDir\package.json" -Destination "$BotResourceDir\package.json" -Force

# 7. Restore dev deps for any subsequent CI steps (vitest, etc.)
Push-Location $BotDir
try {
    Write-Host "Restoring full deps (dev included) for downstream CI steps..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci (restore dev deps) failed" }
}
finally {
    Pop-Location
}

# 8. Verify bundle
$entryPath = Join-Path $BotResourceDir "dist\index.js"
if (-not (Test-Path $entryPath)) { throw "Missing entry: $entryPath" }
$nmPath = Join-Path $BotResourceDir "node_modules"
if (-not (Test-Path $nmPath)) { throw "Missing node_modules: $nmPath" }
$pkgPath = Join-Path $BotResourceDir "package.json"
if (-not (Test-Path $pkgPath)) { throw "Missing package.json: $pkgPath" }

$bundleSize = (Get-ChildItem $BotResourceDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Bundle size: {0} MB" -f ([math]::Round($bundleSize / 1MB, 2)))
Write-Host "Bot bundle ready (directory-mode, requires user Node 20+ at runtime)"
Write-Host "===== build_bot.ps1 done ====="
