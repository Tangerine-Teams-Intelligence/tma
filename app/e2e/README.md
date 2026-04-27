# app/e2e — Playwright E2E for the Tauri shell

Two suites share `playwright.config.ts`:

| Project | Path                    | Purpose                                                |
|---------|-------------------------|--------------------------------------------------------|
| `e2e`   | `app/e2e/`              | Scenario coverage (legacy, partly skipped — see below) |
| `smoke` | `app/playwright-tests/` | 8-route smoke (post-auth, deterministic stubs)         |

Run everything:

```bash
cd app
npx playwright test --reporter=line
```

Run smoke only:

```bash
npx playwright test --project=smoke --reporter=line
# or
npm run smoke
```

## Status — wave 5-γ (2026-04-27)

The `playwright-tests/smoke.spec.ts` 8-route smoke is the active gate.
Several `e2e/*.spec.ts` scenario tests target v1.9.x UI that was reshaped
in Wave 5-α (the meetings list moved under `/sources/discord`, the settings
page collapsed advanced tabs behind a disclosure, the welcome wizard moved
into the `WelcomeOverlay` modal). Those specs are marked `test.skip(true, …)`
with reasons; do not delete — they are the canonical scenario template to
port once the new URL surface stabilises.

`_setup.ts` exports `seedStubSession(page)`, the shared init script that
seeds:

1. `tangerine.auth.stubSession` — bypasses the auth gate.
2. `tangerine.skills` (zustand persist key) — pre-seeds `welcomed: true`
   so the Wave 4-C welcome overlay doesn't intercept clicks, plus
   `memoryConfig.mode = "solo"` so `/memory` doesn't redirect to
   `/onboarding-team`.
3. `window.__TMI_MOCK__` — Tauri command stub mock used by the legacy
   spec fixtures.

## Forward path — expanding coverage

Out of scope for Wave 5-γ; documented here so the next agent has a checklist:

1. **Wave 4-A `MCP sampling /sampler` ws path** — add a Playwright spec that
   hits `/sampler` with the `welcomed=true` seed and asserts the sampling
   chip + ws connection state. Needs a stub for the `__TAURI_INTERNALS__.invoke`
   path that returns `{channel: "mcp_sampling", ...}`. Reference: see
   `app/src/lib/co-thinker.ts` for the `coThinkerDispatch` channel-dispatch
   logic and `app/src-tauri/src/commands/sampling.rs` for the ws contract.

2. **Wave 4-C `WelcomeOverlay`** — there's no test today that exercises the
   modal itself (the smoke seed dismisses it). Add a spec that seeds
   `welcomed: false`, navigates to `/today`, and asserts:
   - the overlay mounts (`data-testid="welcome-overlay"`)
   - clicking "Get started" flips `welcomed: true` in the persisted store
   - the overlay does not re-mount after a `page.reload()`

3. **Re-port the skipped scenarios** — once Wave 5-α lands the new
   `/sources/discord/meetings/<id>/review` path (or whatever the v2.0 URL
   shape is), copy each skipped spec into a new file pointing at the
   updated selectors and remove the `test.skip(true, …)` wrapper.

## Why `_setup.ts` is not a test

Playwright's default `testMatch` is `*.spec.ts` (and the variants), so
filenames starting with an underscore are not auto-discovered. We use
`_setup.ts` as a shared utility module instead of putting the seed code
in `playwright.config.ts::globalSetup` because each spec needs the seed to
fire BEFORE the page navigation, which globalSetup doesn't do.
