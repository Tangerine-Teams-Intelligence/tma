#!/usr/bin/env bash
# E2E smoke test wrapper. Used by CI and local pre-push checks.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python -m pytest tests/smoke_e2e.py -v -s
