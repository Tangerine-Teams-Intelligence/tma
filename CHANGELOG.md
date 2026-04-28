# Changelog

All notable changes to Tangerine AI Teams are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project tries to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- === v1.14.6 round-7 === — rolled-up entries for v1.13 + v1.14 arcs.
     Each version block focuses on user-visible features so this doc can
     also feed the in-app /whats-new-app route. -->

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
