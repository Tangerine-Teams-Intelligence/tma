# Changelog

All notable changes to Tangerine AI Teams are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project tries to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
