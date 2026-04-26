#!/usr/bin/env bash
# Linux/macOS sibling of build_all.ps1 — used by T5's CI matrix.
# v1.5.0-beta is Windows-first; non-Windows builds are informational only.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
APP_DIR="$REPO_ROOT/app"
SRC_DIR="$REPO_ROOT/src"
BOT_DIR="$REPO_ROOT/bot"

echo "===== build_all.sh ====="

# 1. Frozen Python via pyinstaller.
PY_OUT="$APP_DIR/resources/python"
rm -rf "$PY_OUT"
mkdir -p "$PY_OUT"

WORK_ROOT="${TMPDIR:-/tmp}/tmi-build"
rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT/dist" "$WORK_ROOT/build" "$WORK_ROOT/spec"

if ! command -v pyinstaller >/dev/null 2>&1; then
  echo "pyinstaller missing — pip install pyinstaller==6.6.0" >&2
  exit 1
fi

pushd "$REPO_ROOT" >/dev/null
pyinstaller \
  --noconfirm --clean --onedir \
  --name tmi-frozen \
  --paths "$SRC_DIR" \
  --collect-submodules tmi \
  --distpath "$WORK_ROOT/dist" \
  --workpath "$WORK_ROOT/build" \
  --specpath "$WORK_ROOT/spec" \
  "$SRC_DIR/tmi/cli.py"
popd >/dev/null

cp -R "$WORK_ROOT/dist/tmi-frozen/." "$PY_OUT/"
# Rename frontend exe to python(.exe) so the Rust runner finds it.
if [[ -f "$PY_OUT/tmi-frozen" ]]; then
  mv "$PY_OUT/tmi-frozen" "$PY_OUT/python"
fi

# 2. Bot directory bundle (Path D — pkg dropped, runs on user Node 20+).
BOT_OUT="$APP_DIR/resources/bot"
rm -rf "$BOT_OUT"
mkdir -p "$BOT_OUT"

pushd "$BOT_DIR" >/dev/null
[[ -d node_modules ]] || npm ci
npm run build
cp -R "$BOT_DIR/dist" "$BOT_OUT/dist"

# Reinstall production-only for a smaller bundle, copy node_modules, restore.
npm ci --omit=dev
cp -R "$BOT_DIR/node_modules" "$BOT_OUT/node_modules"
cp "$BOT_DIR/package.json" "$BOT_OUT/package.json"
npm ci
popd >/dev/null

# 3. Tauri.
pushd "$APP_DIR" >/dev/null
npm run tauri build
popd >/dev/null

echo "===== build_all.sh done ====="
