# Build the frozen Python interpreter + tmi CLI bundle for Tangerine AI Teams.
# Output: app\resources\python\python.exe (PyInstaller --onedir mode)
#
# Critical: PyInstaller silently mis-handles paths with spaces and non-ASCII
# characters on Windows. The repo lives at "C:\Users\daizhe zo\Desktop\..."
# which has both. Strategy:
#   1. Build inside a short ASCII work dir (TEMP\tmi-build) to dodge the bug.
#   2. Use --distpath / --workpath / --specpath all pointed there.
#   3. After success, robocopy back to app\resources\python\.
#
# Requires: Python 3.11+, pip, pyinstaller 6.x (`pip install pyinstaller`).

$ErrorActionPreference = "Stop"
$RepoRoot  = (Resolve-Path "$PSScriptRoot\..\..").Path
$AppDir    = Join-Path $RepoRoot "app"
$SrcDir    = Join-Path $RepoRoot "src"
$OutDir    = Join-Path $AppDir   "resources\python"
$WorkRoot  = Join-Path $env:TEMP "tmi-build"
$DistDir   = Join-Path $WorkRoot "dist"
$WorkDir   = Join-Path $WorkRoot "build"
$SpecDir   = Join-Path $WorkRoot "spec"

Write-Host "===== build_python.ps1 ====="
Write-Host "Repo root : $RepoRoot"
Write-Host "Src dir   : $SrcDir"
Write-Host "Out dir   : $OutDir"
Write-Host "Work root : $WorkRoot   (ASCII-safe staging area)"

# 1. Preflight: pyinstaller present? Probe several common Windows locations
#    because `pip install --user pyinstaller` lands in %APPDATA%\Python\... and
#    that directory is not on PATH by default.
$pyinst = (Get-Command pyinstaller -ErrorAction SilentlyContinue)
if ($pyinst) {
  $pyinstCmd = $pyinst.Source
} else {
  $candidates = @(
    (Join-Path $env:APPDATA   "Python\Python311\Scripts\pyinstaller.exe"),
    (Join-Path $env:APPDATA   "Python\Python312\Scripts\pyinstaller.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\Scripts\pyinstaller.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\Scripts\pyinstaller.exe")
  )
  $pyinstCmd = $null
  foreach ($c in $candidates) {
    if (Test-Path $c) { $pyinstCmd = $c; break }
  }
  if (-not $pyinstCmd) {
    Write-Error "pyinstaller not found. Install with: pip install --user pyinstaller==6.6.0"
    exit 1
  }
}
Write-Host "pyinstaller: $pyinstCmd"

# 2. Reset work dirs.
Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Path $WorkRoot, $DistDir, $WorkDir, $SpecDir | Out-Null

# 3. Run PyInstaller from RepoRoot so `tmi.cli` import resolves.
Push-Location $RepoRoot
try {
  # Use the entry shim (NOT src/tmi/cli.py directly). cli.py uses relative
  # imports (`from . import __version__`); freezing it as the script strips
  # the package context and the resulting binary crashes at import. The shim
  # imports `tmi.cli` so PyInstaller bundles everything as a proper package.
  $entryScript = Join-Path $PSScriptRoot "_entry\tmi_entry.py"
  if (-not (Test-Path $entryScript)) {
    Write-Error "Missing entry shim: $entryScript"
    exit 2
  }

  # Hidden imports for the local Whisper transcription path (WHISPER_MODE=local
  # in the bot). PyInstaller can't discover these because `tmi.transcribe`
  # imports `faster_whisper` lazily inside a function, and CTranslate2 has
  # platform-specific .pyd modules that need explicit collection.
  $pyiArgs = @(
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name", "tmi-frozen",
    "--paths", $SrcDir,
    "--collect-submodules", "tmi",
    "--collect-data", "tmi",
    "--collect-all", "faster_whisper",
    "--collect-all", "ctranslate2",
    "--collect-all", "tokenizers",
    "--collect-all", "huggingface_hub",
    "--hidden-import", "tmi.transcribe",
    "--hidden-import", "tmi.model_download",
    "--distpath", $DistDir,
    "--workpath", $WorkDir,
    "--specpath", $SpecDir,
    $entryScript
  )
  Write-Host "Running: $pyinstCmd $($pyiArgs -join ' ')"
  & $pyinstCmd @pyiArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Error "pyinstaller exited with $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}

# 4. Copy the resulting --onedir tree into app\resources\python\.
$Frozen = Join-Path $DistDir "tmi-frozen"
if (-not (Test-Path $Frozen)) {
  Write-Error "PyInstaller output missing at $Frozen"
  exit 3
}

# Wipe old output, recreate.
if (Test-Path $OutDir) {
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Path $OutDir | Out-Null

# Copy frozen tree → resources/python.
# IMPORTANT: do NOT use `Start-Process -ArgumentList @(...)` here. On Windows
# PowerShell 5.1, Start-Process re-joins the array with single spaces and
# `robocopy.exe` then sees "C:\Users\daizhe zo\..." as TWO args. The result
# is a silently-truncated destination ("C:\Users\daizhe\") and exit code 16.
# The fix is to invoke robocopy directly via `&` so PowerShell's native
# argument quoting handles the space correctly.
& robocopy.exe $Frozen $OutDir /E /NFL /NDL /NJH /NJS /NP /MT:8
$rcExit = $LASTEXITCODE
# robocopy success exit codes are 0-7; 8+ is failure.
if ($rcExit -ge 8) {
  Write-Error "robocopy failed with exit $rcExit"
  exit $rcExit
}

# PyInstaller produces tmi-frozen.exe; rename to python.exe for runner.rs.
$FrozenExe = Join-Path $OutDir "tmi-frozen.exe"
$TargetExe = Join-Path $OutDir "python.exe"
if (Test-Path $FrozenExe) {
  Move-Item -Force $FrozenExe $TargetExe
}

# 5. Smoke test: run the frozen exe with `--help` (the typer CLI returns 0).
Write-Host "Smoke testing $TargetExe ..."
$smokeOutput = & $TargetExe "--help" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Smoke test exit code: $LASTEXITCODE"
  Write-Warning ($smokeOutput | Out-String)
} else {
  Write-Host "Smoke test OK."
}

# 6. Report bundle size.
$sizeBytes = (Get-ChildItem -Recurse $OutDir | Measure-Object -Sum -Property Length).Sum
$sizeMB = [math]::Round($sizeBytes / 1MB, 1)
Write-Host "Python bundle size: $sizeMB MB at $OutDir"
Write-Host "===== build_python.ps1 done ====="
