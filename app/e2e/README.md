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

## Cross-platform validation strategy (wave 25)

Wave 17 set up a 5-platform installer matrix in `.github/workflows/release.yml`
(Windows / macOS aarch64 / macOS x64 / Linux .deb / Linux .AppImage). Wave 25
ships the auto-updater on top of that matrix. CEO has no Mac/Linux dev
machines locally, so the validation strategy is staged:

1. **Local (CEO)** — `npm test -- --run` + `cargo test --tests` on Windows.
   Cross-platform code paths are guarded by `#[cfg(...)]` blocks (see
   `src-tauri/src/commands/external.rs::open_with_default_handler`) so the
   Windows test run still compiles + executes the platform-agnostic surface.

2. **CI matrix** — every tag push fans out to 5 GitHub-hosted runners
   (windows-latest / macos-14 / macos-13 / ubuntu-22.04 ×2). A Mac/Linux
   compile failure surfaces in the matrix log even before any human
   touches the artifact.

3. **Outside testers** — the release notes call out which artifacts are
   "shell preview" (no meeting capture). Volunteers download from the
   GitHub Release page and run `dogfood-prep/CHECKLIST.md` Phase 1-5
   on their native OS.

4. **Updater dogfood** — once `latest.json` ships in v1.12.0, we tag a
   v1.12.1 patch release and confirm:
     * Windows install of v1.12.0 surfaces the "v1.12.1 available" banner.
     * macOS / Linux installs do the same (the `latest.json` schema covers
       all three; the plugin is platform-agnostic).
     * Click "Install now" → restart → version bumps to v1.12.1.
   The signature placeholder will refuse install until CEO runs
   `npx tauri signer generate -w ~/.tauri/myapp.key` and stores the
   matching private key in repo secrets as `TAURI_SIGNING_PRIVATE_KEY`.

5. **Updater plugin parity** — `tauri-plugin-updater` officially supports
   Windows (NSIS), macOS (DMG + app bundle replace), and Linux (AppImage
   only — `.deb` requires a separate package-manager flow not covered
   here). For `.deb` users we fall back to the GitHub Releases page.

## Why `_setup.ts` is not a test

Playwright's default `testMatch` is `*.spec.ts` (and the variants), so
filenames starting with an underscore are not auto-discovered. We use
`_setup.ts` as a shared utility module instead of putting the seed code
in `playwright.config.ts::globalSetup` because each spec needs the seed to
fire BEFORE the page navigation, which globalSetup doesn't do.
