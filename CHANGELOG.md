# Changelog

All notable changes to Tangerine AI Teams are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project tries to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- === v1.14.6 round-7 === — rolled-up entries for v1.13 + v1.14 arcs.
     Each version block focuses on user-visible features so this doc can
     also feed the in-app /whats-new-app route. -->

## [1.15.0] — 2026-04-28 — Onboarding reboot + activation funnel

The "装上就死" → "装上 5 分钟用起来" release. v1.14.6 first-launch fell
into a chicken-and-egg loop: the conversational onboarding needed an LLM
to parse the user's tool name, but the LLM ran inside the tool the user
hadn't connected yet. v1.15.0 inverts the default: form-first wizard
with auto-detection, demo mode promoted to a first-class try-before-config
path, and a real activation funnel (`first_real_atom_captured`) so v1.15.1
can be data-driven instead of guess-driven.

### Added
- **SetupWizard 三路径 first-launch card layout.** Cold launches with
  `onboardingCompletedAt === null` mount a wizard that asks one question:
  Connect AI tool / Try with sample data / Configure manually. Wave 11's
  form is still here — it's the third card, not the default. The chat
  onboarding is demoted to Settings → Advanced ("Configure with AI").
- **AIToolDetectionGrid covering all 8 AI tools.** Cursor / Claude Code /
  Codex / Windsurf get one-click MCP auto-configure (atomic JSON / TOML
  merge into the tool's own config — never overwrites existing servers,
  idempotent). Devin / Replit get keychain-backed remote config. Apple
  Intelligence / MS Copilot surface as `PlatformUnsupported` with an
  honest reason chip — no fake green check. Display order: detected
  first, then market rank.
- **MCP server health-check polling.** After Auto-configure, the grid
  polls `mcp_server_handshake(tool_id)` every 3 s for up to 30 s. UI
  states cycle Configuring → Waiting for restart → Connected ✓ on a
  successful handshake; `Restart [tool] to finish setup` on timeout
  with a Retry button that re-arms the same poll. The handshake reads
  the in-process MCP sampling-bridge registry (no probe spawn that
  would race the user's editor for stdio).
- **DemoTourOverlay — 5-step guided tour over sample data.** Picking
  the demo card flips `demoMode = true`; AppShell mounts a
  non-blocking dialog that walks the user through /memory → /people →
  /threads → /co-thinker → "Ready for real?". The conversion CTA
  physically deletes the sample atoms via `demo_seed_clear` (preserving
  R9 sample-vs-real isolation), drops `demoMode`, latches
  `demoTourCompleted = true`, and routes back to the wizard. Skip /
  Esc at any step latches `demoTourCompleted` only — sample data
  stays so the user can keep browsing.
- **EmptyStateCard on /people /threads /co-thinker /today /this-week
  /memory.** First-time users (`firstAtomCapturedAt === null`) now see a
  "Capture your first [thing]" card with a CTA back into the AI-tool
  detection grid plus a "See the demo →" secondary that re-enters demo
  mode. Returning users with a quiet day fall through to the existing
  lighter "no items yet" message.
- **`first_real_atom_captured` activation event.** Headless React
  listener subscribes to the existing `activity:atom_written` Tauri
  event, filters out R9 sample atoms via the propagated `is_sample`
  flag, latches `firstAtomCapturedAt` exactly once, and emits the event
  for the activation funnel. The listener self-skips after latch — zero
  IPC cost for returning users.
- **SoloCloudUpgradePrompt — first paywall trigger.** Non-blocking
  global banner above the route shell. Eligibility = ≥ 7 d post-onboard
  OR ≥ 50 atoms (whichever first), AND not currently in team mode.
  Dismiss latches `soloCloudPromptDismissedAt` for a 7 d cool-down
  window. Upgrade CTA opens an external Stripe Checkout URL (read from
  `VITE_STRIPE_SOLO_CHECKOUT_URL` build env var). Emits
  `solo_cloud_upgrade_prompt_shown` / `solo_cloud_upgrade_clicked` /
  `solo_cloud_upgrade_dismissed` for funnel analytics.
- **First-launch detection vs. upgrade-launch detection.**
  `onboardingCompletedAt` smart-upgrade hydration pre-stamps the latch
  for any v1.14.6 user who already passed the wave 11 wizard or
  welcomed. They upgrade into v1.15.0 and the new wizard never appears.
- **14 + 2 new typed telemetry events.** The full Wave 1.15 funnel
  (onboarding_wizard_shown → onboarding_path_chosen →
  onboarding_detection_completed → onboarding_mcp_configured /
  onboarding_mcp_failed / onboarding_mcp_timeout → mcp_connected →
  first_real_atom_captured → onboarding_completed) plus demo path
  (demo_tour_step_completed × 5 → demo_tour_dismissed |
  demo_to_real_conversion) plus paywall trio. All have typed payload
  shapes via `logTypedEvent<E>(...)` — strict TS, no `any`. Existing
  `logEvent` call sites stay on the untyped path for back-compat.

### Changed
- **OnboardingChat is no longer the first-launch surface.** Lives in
  Settings → Advanced. Error messages rewritten from "ollama isn't
  responding" to "Open your AI tool first (Cursor / Claude Code) so
  I can borrow its LLM" — honest about the actual prerequisite.
- **`setup_wizard_auto_configure_mcp` delegates unknown tool_ids.**
  Wave 11's existing 4-tool dispatcher now falls through to W1.3's
  v15 dispatcher for `devin` / `replit` / `apple-intelligence` /
  `ms-copilot`. Single React call site (`setupWizardAutoConfigureMcp`)
  handles all 8 tools.

### Fixed
- 2 baseline test-file flakes (`co-thinker.test.tsx`,
  `routes.smoke.test.tsx`) updated to drive the returning-user path
  now that the empty branches render the new EmptyStateCard.

### Tests
- 670 → 783 passing vitest (+113 new specs across 7 new files); 3
  failures are pre-existing wave21 MemoryTree DOM testid races
  documented in v1.13 R10.
- 768 → 803 passing cargo --lib (+30 new setup_wizard tests + 2
  activity tests + 3 perf tests still flake under load — same as
  v1.14.6 baseline, run in isolation to verify).
- **0 cargo warnings** preserved.
- 226 / 226 pytest passing (+8 new event_router activation specs).

### Known shippable gaps (deliberately deferred)
- Local LLM bundle (Llama 3.2 1B sidecar). Decision deferred to
  v1.15.1 pending real telemetry on auto-configure success rate; if
  ≥ 85 % of users complete onboarding via the detection grid we may
  not need it.
- Team Cloud / Enterprise paywall. Solo is the only tier wired in
  v1.15.0.
- Cross-machine 2-Playwright presence E2E. R7 still in-process only.

## [1.14.6] — 2026-04-28

Round 7 closes the v1.14 arc. Final 10/10 dimension lift on real-time
presence (4-teammate burst debounce) + discoverability (in-app version
changelog).

### Added
- **Burst debounce on multi-teammate presence updates.** A 4+ teammate
  standup now coalesces to ≤ 2 list reads per fan-out window instead of
  one read per emit. 80 ms leading-edge + trailing-flush window keeps
  perceived latency under the spec budget.
- **`/whats-new-app` route.** Reads this CHANGELOG so v1.14 ship signals
  show inside the app, not only on GitHub. First launch after upgrade
  fires a one-shot toast pointing at it (gated by `lastSeenAppVersion`
  in the persisted store).
- **`presence:write_failed` Tauri event.** Surfaces hard FS errors
  (PermissionDenied / ReadOnly / StorageFull) that pre-R7 were silently
  swallowed. Heartbeat keeps ticking; UI gets a one-shot signal.

### Fixed
- `write_local_presence` no longer masks all I/O errors. Soft errors
  still keep the heartbeat resilient; hard errors propagate so the user
  knows their presence isn't being shared.

## [1.14.5] — 2026-04-27

Round 6 — AI capture moat polish. PersonalAgentDetectionStatus refactored
to a tagged-enum so the React side can tell "no agents detected" from "we
don't know yet" instead of one bool.

### Added
- Tagged-enum status surface for personal agents (Cursor / Claude Code /
  Codex / Windsurf). Settings → Personal Agents now distinguishes
  "Not detected" / "Detection in progress" / "Detected, capture armed" /
  "Detected, capture off" instead of one boolean.

## [1.14.0 → 1.14.4] — 2026-04-25 → 2026-04-26

Rounds 1-5 closing v1.13 carryovers. Six dimensions lifted from 7-8 to
8.5-9.5. No breaking changes.

### Added
- **2-user team-invite cold-start E2E.** `parseInvite` mock + 2-user E2E
  pin the Solo+Team funnel (R1).
- **JSON duplicate-key lint** as part of CI. R4 catches the
  same-shape regression that swallowed ~110 i18n entries pre-v1.13.10.
- **`tauri-plugin-opener` migration.** Drops the only remaining cargo
  deprecation warning (R4).
- **Markdown-native backlinks LinkCache.** R5 turns the per-render
  scan into a memoized lookup; opening a heavily-backlinked atom no
  longer drops a frame.

### Changed
- Sample-detection on memory tree walk now mtime-cached (R2). Cold-cache
  p50 stays under the revised 1000 ms budget; warm cache returns under
  100 ms.
- External-comm capture parity sweep (R3). Slack / email / calendar
  GetConfig paths now use strict invoke + surface honest errors.

## [1.13.10] — 2026-04-22

Ship-readiness round (R10) of the v1.13 arc. Eight of ten dimensions
≥ 8/10. NSIS installer unsigned but build-clean.

### Added
- WhatsNewBanner — surfaces new ATOMS since the last view-all sweep.
- Privacy panel honest-on-failure (R6 fix — pre-R6 it rendered fake
  green checks on Rust failure).

### Fixed
- `apply_review_decisions` had been a silent no-op since v1.0; restored.
- Duplicate `"sources":` JSON key in en + zh common.json swallowing
  ~110 i18n entries via JSON.parse last-wins semantics.

## [1.13.0 → 1.13.9] — 2026-04-15 → 2026-04-21

Wave 1.13 — Local-first dual-layer capture, real-time team presence,
extracted-mention pipeline, sample-data tagging, identity layer.

### Added
- **Real-time team presence (Wave 1.13-D).** PresenceProvider mounted
  at AppShell-level, 10 s heartbeat + on-route emit, `presence:update`
  Tauri event for multi-window instant refresh (added in v1.13.5
  round-5; no longer relies solely on the polling cycle).
- **Identity / team roster (Wave 1.13-A).** UserProfile, TeamMember,
  team_roster module land. WelcomeOverlay deep-links into the privacy
  panel via `?tab=privacy`.
- **Privacy panel (Wave 1.13-E).** First-class default tab — one click
  to confirm what stays local.
- **AIExtractedMentionCard.** Wave 1.13-C's unique-moat surface finally
  wired into /inbox renderer (was test-passing but invisible to users
  pre-R2).
- **`extractMentions` helper.** Wired into CommentInput so @username
  preview appears before Post.

## [1.5.1-beta] — 2026-04-25

Build re-tag for the local-Whisper + super-app shell pipeline. No new features
beyond what was queued for 1.5.0-beta; this version exists to retrigger the
release workflow after a toolchain pin (Rust 1.89.0) was added to fix a
`keyboard-types 0.7` serde-derive break on rustc 1.90+.

### Changed
- Rust toolchain pinned to 1.89.0 via `app/src-tauri/rust-toolchain.toml`. CI
  workflow updated to honor the pin (`dtolnay/rust-toolchain@stable` does not).
- Local Whisper (`faster-whisper`) replaces the OpenAI Whisper API. Model
  download UX wired into the super-app skill drawer; OpenAI is now optional.
- Setup wizard removed in favor of a super-app shell (auth → dashboard →
  skills). T3 commands handler + `AppState` now wired into the Tauri builder.
- Frozen Python entry dispatches via `runpy -m <module>` so PyInstaller
  `--onedir` covers `faster-whisper` transitive deps. `huggingface_hub` stdout
  pollution silenced in `model_download`.

## [1.5.0-beta] — 2026-04-24

First public Windows beta. Single-skill release: Tangerine Meeting (Discord →
Claude Code memory diff). Distributed as an unsigned NSIS installer.

### Added
- **Desktop shell** (`app/`) — Tauri 2.x + React 19 wizard-driven UI replacing
  the previous CLI-only flow. 5-step first-run wizard: Discord bot setup,
  Whisper API key, Claude Code detection, team config, first meeting.
- **NSIS installer** — per-user install (no UAC, no signing required), English
  + Simplified Chinese, Start Menu folder "Tangerine", shortcut "Tangerine AI
  Teams".
- **Frozen runtimes** bundled into the installer:
  - Python 3.11 + `tmi` CLI via PyInstaller `--onedir`
    (`app/resources/python/python.exe`).
  - Discord bot via `pkg` single-file binary
    (`app/resources/bot/tangerine-meeting-bot.exe`).
- **Release workflow** (`.github/workflows/release.yml`) — Windows-latest
  runner builds Python + bot + Tauri app on every `v*` tag and publishes the
  installer to GitHub Releases. Pre-release detection for `*-beta`/`*-alpha`/
  `*-rc` tags.
- **Build scripts** (`app/scripts/build_python.ps1`, `build_bot.ps1`,
  `build_all.ps1`) — local + CI-compatible Windows build orchestration with
  non-ASCII path mitigations.
- README download badge + Latest Release link.

### Known issues
- Installer is **unsigned**; Windows SmartScreen will warn on first run. Code
  signing certificate procurement is tracked for v1.5.1.
- Identifier is `ai.tangerineintelligence.meeting` (legacy from pre-rebrand).
  Changing it would orphan future-upgrade install state on existing installs;
  rebrand-aligned identifier `ai.tangerineintelligence.teams` is deferred to
  v2.0 when we can break upgrade compatibility cleanly.
- macOS / Linux installers are not yet built.

### Notes for first CI run
The release pipeline has never run end-to-end on GitHub Actions before this
tag. Expect first-run debugging around: native bindings for `@discordjs/voice`
+ `@discordjs/opus` under `pkg`, and PyInstaller hidden-import resolution for
the `tmi` package. Both build scripts are designed to fail loudly with
specific error messages.

## [0.1.0] — 2026-04-17

Pre-release CLI-only build. Apache-2.0 OSS-ready release: full pipeline +
docs + demo + CI. Not distributed as installer.
