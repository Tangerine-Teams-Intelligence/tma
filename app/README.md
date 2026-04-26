# Tangerine AI Teams — Desktop App

> **Align every AI tool on your team with your team's actual work.**

Tauri 2.x desktop shell that wraps Tangerine's capture pipeline and exposes the team-memory layer to every AI tool on the team. Wraps the Python `tmi` CLI and Node Discord bot in a native Windows app. Top-level flow: sign in → install the Meeting skill → first meeting. Spec lives in `../APP-INTERFACES.md`.

## Status

- T1 (this PR) — super-app shell (auth → dashboard → skills marketplace → per-skill config) + theming + Zustand store + Vitest/Playwright scaffold. The legacy 5-step wizard has been retired in favour of a single Meeting skill config form.
- T2 — meetings list, detail, live, review, apply, settings (placeholders here)
- T3 — Rust IPC commands (in `src-tauri/src/commands/*.rs`; partially landed)

## Prerequisites

- Node 20.x
- Rust 1.78+ (with `rustup default stable`)
- Windows 11 (primary target). macOS / Linux dev builds work but unsigned.
- WebView2 Runtime (preinstalled on Win11; auto-installed on Win10 by Tauri).

## First-time setup

```bash
cd app
npm install
```

The Rust crate fetches its own dependencies on first `tauri dev` build.

## Run dev mode

```bash
npm run tauri:dev
```

This launches the native app window with the React UI hot-reloading from
`http://localhost:1420`. The auth screen is the boot gate. After sign-in
(stub mode if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are unset) the
dashboard renders; install the Meeting skill from the marketplace to configure
Discord, Whisper, Claude, and team members.

## Web-only iteration (no Rust rebuild)

```bash
npm run dev
```

Opens the React UI in your browser at `http://localhost:1420`. Tauri commands
fall back to mock implementations (see `src/lib/tauri.ts`), so auth + skill
config walk end-to-end without a working Rust backend. Useful for UI polish
and component-level testing.

## Tests

```bash
npm test          # vitest unit tests (store, discord helpers, token regex)
npm run test:e2e  # playwright smoke (scaffold; T2 fills the real flows)
npm run lint      # tsc --noEmit
```

## Build production installer

```bash
npm run tauri:build
```

Produces `src-tauri/target/release/bundle/nsis/Tangerine AI Teams Setup.exe`.
T4 owns final installer polish + Python/Node bundling.

## Directory map

```
app/
├── src/
│   ├── App.tsx              top-level router; gates on config presence
│   ├── components/
│   │   ├── ui/              shadcn-style primitives (button, input, card, ...)
│   │   ├── layout/          AppShell + Sidebar
│   │   └── wizard/          legacy SW0..SW5 components (no longer routed; field UI is reimplemented inline in routes/skills/meeting.tsx)
│   ├── routes/              auth.tsx, dashboard.tsx, skills/index.tsx, skills/meeting.tsx, home.tsx, setup.tsx (redirect)
│   ├── pages/               placeholder pages owned by T2
│   └── lib/
│       ├── tauri.ts         typed `invoke()` wrappers + mocks
│       ├── supabase.ts      Supabase client singleton (stub mode when env vars unset)
│       ├── auth.ts          useAuth hook + signIn/signUp/signOut
│       ├── store.ts         Zustand slices: ui, wizard (legacy), config, skills
│       ├── discord.ts       SW-1.3 polling constants + token helpers
│       └── utils.ts
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          T1 — window glue, shell-only commands
│   │   ├── lib.rs           T1 — link surface for tests + binary
│   │   └── commands/        T3 — IPC commands (parallel work)
│   ├── tauri.conf.json      product metadata, NSIS config
│   ├── Cargo.toml           Rust deps (T3-managed)
│   └── icons/               placeholder; T4 replaces with brand assets
├── tests/                   vitest setup + unit tests
└── e2e/                     playwright scaffold
```

## Cross-team contracts owned here

CSS variables (locked — see `src/index.css`):
- `--ti-orange-{50,500,600,700}`, `--ti-navy-{700,900}`, `--ti-paper-{50,100,200}`,
  `--ti-ink-{300,500,700,900}`, `--ti-border-{faint,default}`,
  `--ti-font-{sans,mono,display}`, `--ti-radius`, `--ti-dur-fast`, `--ti-ease-out`.

Zustand slice names (locked — see `src/lib/store.ts`):
- `useStore.getState().ui.{theme, sidebarCollapsed, toasts, ...}`
- `useStore.getState().wizard.{step, collected, next, back, setField, reset}`
- `useStore.getState().config.{yaml, loaded, setYaml, markLoaded}`

Tauri command names (per APP-INTERFACES.md §4 — T3 owns implementations):
- Process: `run_tmi`, `run_tmi_send_stdin`, `run_tmi_kill`, `start_bot`, `stop_bot`, `bot_status`
- FS: `read_meeting`, `read_meeting_file`, `list_meetings`, `tail_file`, `untail_file`, `watch_meeting`, `unwatch_meeting`
- Config: `get_config`, `set_config`, `get_secret`, `set_secret`
- System: `open_external`, `open_in_editor`, `show_in_folder`, `system_notify`, `export_debug_bundle`, `check_updates`
- Wizard: `detect_claude_cli`, `validate_target_repo`, `validate_whisper_key`, `poll_discord_bot_presence`

`src/lib/tauri.ts` exports a typed wrapper for every name above. T2 should
import from there rather than calling `invoke()` directly.
