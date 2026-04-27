# tests/

Python tests for the legacy `tmi` CLI surface. Most live tests are unit-level
(see `test_*.py`); the smoke E2E (`smoke_e2e.py`) drives the full
init → new → prep → wrap → review → apply lifecycle with `--mock-claude` to
keep the run hermetic.

## Status — wave 5-γ (2026-04-27)

E2E smoke covers the **legacy `tmi` CLI workflow only**. The Tauri-app E2E
lives in `app/e2e/` (Playwright) and is the active forward path.

The Python E2E exercises subprocess-based Claude integration via the
`--mock-claude` flag (see `src/tmi/observer/mock_claude.py`). v2.0 will
re-architect the meeting wrap-up around MCP sampling inside the Tauri app
(see `V2_0_SPEC.md`), at which point this smoke will be retired in favor of
a Playwright-driven flow against the desktop shell.

### Running locally

```bash
# From the repo root
pip install -e ".[dev]"
pytest tests/ -v
# Or smoke-only:
bash tests/smoke_e2e.sh
```

If `pytest tests/smoke_e2e.py` fails with
`ModuleNotFoundError: No module named 'tmi'`, you forgot the editable
install — the CLI is exposed via the `tmi = "tmi.cli:app"` entry point in
`pyproject.toml::[project.scripts]`, which only resolves once `pip install -e`
has run.

### CI gating

`.github/workflows/ci.yml::e2e` job runs `bash tests/smoke_e2e.sh` after the
`python` and `node` jobs pass, with `pip install -e ".[dev]"` as the bootstrap
step. The smoke test is intentionally a hard gate today — when it breaks we
want to hear about it before merging.

When v2.0 lands (see `V2_0_SPEC.md`), the plan is:

1. Wire a Playwright smoke covering `MCP sampling /sampler` ws path against
   the Tauri app (Wave 4-A territory; see `app/e2e/README.md`).
2. Demote `tests/smoke_e2e.py` to `continue-on-error: true` for one release
   cycle so contributors get a soft warning if it regresses on the legacy
   path.
3. Remove the legacy smoke once Playwright coverage matches its scope
   (lifecycle + diff apply + state machine).

Until then, treat `smoke_e2e.py` as load-bearing.
