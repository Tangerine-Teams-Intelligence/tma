# APP-INTERFACES.md — Tangerine Meeting v1.5 (Desktop App)

**Status**: Locked 2026-04-24
**Audience**: Six parallel implementation agents (T1–T6) building the Tauri desktop app on top of TMA v0.1 CLI.
**Companion docs**:
- `INTERFACES.md` — TMA v0.1 CLI contract (D0–D5 work). The desktop app **wraps** this CLI; every command in CLI §4 and every schema in CLI §2 remains authoritative.
- `PLAN.md` — product spec.
- `README.md` — positioning.
- `docs/TMA-立项书-v1.3-draft.md` §4 — five-phase user flowchart (Phase 0–5 mental model).

This document specifies every cross-component boundary inside the Tauri app: window shape, screen inventory, IPC commands, setup wizard step semantics, state ownership, packaging, distribution, gates. A reader should be able to implement any one screen, the Rust core, or the installer pipeline without coordinating with the others, as long as everyone obeys this file.

Conventions:
- All paths POSIX-style; Rust normalizes via `std::path::Path` on Windows.
- All timestamps RFC 3339, default TZ `Asia/Shanghai` (`+08:00`).
- Tauri command names `snake_case`; React component names `PascalCase`; CSS variables match `--ti-*` (mirroring `tangerine-learn`).
- `[design-call: X because Y]` annotations mark places this doc resolved an ambiguity left open by upstream specs.

---

## §1 App Component Map

The Tauri app is **THIN**. It is a GUI shell that spawns and talks to the existing Python CLI + Node bot via process IPC. Business logic stays in the CLI; the app reads files and renders state.

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Tangerine Meeting.exe (Tauri 2.x)                  │
│                                                                      │
│  ┌────────────────┐         IPC          ┌────────────────────────┐  │
│  │  React UI      │ ◄────  invoke()  ──► │  Rust core             │  │
│  │  (app/src/)    │                      │  (app/src-tauri/src/)  │  │
│  │                │ ◄──── events ─────── │                        │  │
│  │  - screens     │                      │  - window mgmt         │  │
│  │  - state (Zus) │                      │  - process spawner     │  │
│  │  - shadcn/ui   │                      │  - fs watcher          │  │
│  └────────────────┘                      │  - auto-update         │  │
│                                          │  - notifications       │  │
│                                          └────────────┬───────────┘  │
│                                                       │              │
│                  ┌────────────────────────────────────┴────────┐     │
│                  │                                              │     │
│                  ▼                                              ▼     │
│  ┌─────────────────────────────────┐    ┌──────────────────────────┐ │
│  │ Bundled Python (PyInstaller)    │    │ Bundled Node (pkg/SEA)   │ │
│  │ resources/python/python.exe     │    │ resources/bot/bot.exe    │ │
│  │   → runs `python -m tmi.cli`    │    │   → Discord bot          │ │
│  │   → owns meeting lifecycle       │    │   → Whisper streaming    │ │
│  └─────────────────────────────────┘    └──────────────────────────┘ │
│                  │                                       │            │
│                  └────────► meetings/<id>/ ◄─────────────┘            │
│                             (filesystem schema, INTERFACES.md §2)     │
└──────────────────────────────────────────────────────────────────────┘
```

### Component ownership (locked)

| Component | Language | Lives in | Owns |
|---|---|---|---|
| **Rust core** | Rust 1.78+ | `app/src-tauri/src/` | Window management, IPC commands, process spawn/lifecycle, FS watch, auto-update, system notifications, single-instance lock |
| **React UI** | TypeScript 5 + React 18 | `app/src/` | All screens (wizard / meetings / live / review / settings), routing, Zustand store, theme |
| **Bundled Python** | Python 3.11 (frozen) | `app/resources/python/` | Frozen `tmi` CLI via PyInstaller `--onedir`. Unchanged source. |
| **Bundled Node** | Node 20 (frozen) | `app/resources/bot/` | Frozen Discord bot via `pkg` or Node SEA. Unchanged source. |
| **CLI source** | Python | `src/tmi/` (repo root) | Unchanged. Authoritative for business logic per INTERFACES.md. |
| **Bot source** | TypeScript | `bot/` (repo root) | Unchanged. |

### Communication boundaries

- **React ↔ Rust**: Tauri `invoke()` (commands, request/response) + `listen()` (events, push). Defined exhaustively in §4.
- **Rust ↔ Python/Node**: stdlib `std::process::Command`. Stdout streamed line-by-line over Tauri events. Stdin piped for interactive `tmi prep`.
- **Rust ↔ filesystem**: `notify` crate watches `meetings_repo/` and the active meeting dir; React store auto-refreshes on change.
- **No HTTP, no socket, no IPC daemon.** Every state change leaves a file on disk, exactly as INTERFACES.md mandates.

The app never re-implements anything in `tmi` or the bot. If a button needs to do work, that work happens by spawning the CLI subprocess.

---

## §2 Window Structure

- **Single main window**. Min size 1200×800. Resizable. Position + size persisted via Tauri `window-state` plugin to `%LOCALAPPDATA%\TangerineMeeting\window.json`.
- **Layout**: left sidebar (240px, collapsible to 64px icons-only) + main content area. No multi-window in v1.5; review and live both render inside main window content area, not popups.
- **Sidebar tabs**: Meetings (home), Live (only visible when a meeting is `live`), Settings, Help. Setup wizard takes over the full window when active.
- **Setup wizard**: modal full-window overlay on first run (or when `~/.tmi/config.yaml` is missing/invalid). Dismissible only when SW-5 reached. No close button until wizard is complete; alt-F4 prompts "Quit and finish setup later? Tangerine Meeting won't work without setup."
- **System tray**: deferred. v1.5.0-beta launches without tray. Tray icon (green/gray/red status) lands in v1.5.1. [design-call: tray adds packaging complexity (autostart registry, signed icon set) that we don't need for the dogfood beta.]
- **Keyboard shortcuts** (global, registered in Rust):
  - `Ctrl+N` — open NM-0 New Meeting form
  - `Ctrl+,` — open ST-0 Settings
  - `Ctrl+R` — refresh meetings list (force re-scan FS)
  - `Ctrl+L` — focus log tail in Live panel (when visible)
  - `Esc` — close any modal; in wizard, asks "Quit setup?" first
- **Window menu**: native menu bar with File / Edit / View / Help. v1.5.0-beta uses the default Tauri-generated menu plus one custom item: Help → "Export Debug Bundle".

---

## §3 Screen Inventory

For every screen the app exposes, this section locks: when the user sees it, what data it reads (and from where), what actions it exposes (and which CLI commands those invoke), and which other screens it can transition to.

### SW-0 Welcome

- **When**: First app launch, or `~/.tmi/config.yaml` missing.
- **Reads**: nothing. Pure static.
- **Layout**: centered card on tangerine-paper background. H1 "Welcome to Tangerine Meeting." Body 1–2 sentences ("Your meeting → your team's AI context, automatically. We'll set up Discord, Whisper, and your Claude Code project. Takes about 5 minutes."). Single CTA button "Get started →" (primary tangerine).
- **Actions**: "Get started" → SW-1.
- **Transitions out**: SW-1 only.

### SW-1 Discord bot wizard

- **When**: After SW-0.
- **Reads**: nothing initially. As user progresses, polls Discord API to detect bot presence (see §5).
- **Layout**: 4 sub-steps (1.1–1.4). Stepper at top showing "1 / 5 — Discord bot". Body changes per sub-step. Two buttons: "Back" (returns to previous sub-step or SW-0) and "Continue" (disabled until current sub-step's validation passes). Full §5 spec below.
- **Actions**: opens `https://discord.com/developers/applications` in default browser via `open_external` IPC; auto-generates OAuth URL with `bot applications.commands` scopes + permissions integer `2150629888` (View Channels, Connect, Speak, Use Voice Activity, Send Messages, Use Slash Commands); polls Discord API `GET /users/@me/guilds` with the user's bot token to detect server installation.
- **Outputs (on advance)**: `discord.bot_token_env` value (held in memory until SW-5 writes config), `discord.guild_id`.
- **Transitions out**: → SW-2 on completion. Back → SW-0.

### SW-2 Whisper API key

- **When**: After SW-1.
- **Reads**: nothing.
- **Layout**: stepper "2 / 5 — Whisper transcription". Body explains "Tangerine Meeting uses OpenAI Whisper to transcribe Discord voice. ~$0.006/min. Paste your OpenAI API key below — we never send it anywhere except OpenAI." Single masked input + eye-toggle. Helper link "Don't have one? Get a key →" opens `https://platform.openai.com/api-keys`.
- **Validation**: starts with `sk-`, length ≥ 40. On Continue: live-validates by calling `POST https://api.openai.com/v1/audio/transcriptions` with a 1-second silent WAV; expects 200 or "audio_too_short" 400 (both mean key is valid). 401 → red error "Invalid key — check OpenAI dashboard."
- **Outputs**: `whisper.api_key_env` value (held in memory).
- **Transitions out**: → SW-3 on validation success. Back → SW-1.

### SW-3 Claude Code detection + project link

- **When**: After SW-2.
- **Layout**: stepper "3 / 5 — Claude Code". Body: "We need a project on your computer where Tangerine Meeting will write decisions. This is your team's AI context — usually the repo where your `CLAUDE.md` lives." Two cards:
  1. "Detected: `claude` CLI at `<path>` — version `<v>`" (auto-detected by spawning `claude --version`; if missing, shows red "Not found. Install Claude Code first →" with link).
  2. "Choose your target repo" — folder picker (Tauri `dialog::open`). On select, app reads the directory and tries to find `CLAUDE.md`, `knowledge/`, `.cursorrules`. Shows green check next to each found file.
- **Validation**: target dir must exist + be a git repo (Rust runs `git rev-parse --is-inside-work-tree`); `claude` CLI must respond.
- **Outputs**: `output_adapters[0].target_repo`, `claude.cli_path`.
- **Transitions out**: → SW-4. Back → SW-2.

### SW-4 Team members

- **When**: After SW-3.
- **Layout**: stepper "4 / 5 — Your team". Body: "Add the people who will join meetings. Each needs a Discord ID we can label transcripts with." Editable table with columns: Alias, Display Name, Discord ID, Remove. "Add row" button. Pre-populated with one row (the user) — alias defaults to first 8 chars of OS username, display_name from system, Discord ID blank.
- **Validation**: ≥ 1 row; all aliases unique + match `^[a-z][a-z0-9_]*$`; Discord IDs (if filled) match `^\d{17,20}$`. Empty Discord ID is allowed (see INTERFACES.md §2.1).
- **Help**: tooltip on Discord ID column: "In Discord, enable Developer Mode (Settings → Advanced), then right-click a user → Copy User ID."
- **Outputs**: `team[]` list.
- **Transitions out**: → SW-5. Back → SW-3.

### SW-5 Setup complete

- **When**: After SW-4.
- **Reads**: nothing.
- **Layout**: centered confirmation card with green check. Body: "Setup complete. Tangerine Meeting is ready." Three sub-actions: "Create your first meeting →" (primary, → NM-0), "Open meetings folder" (Rust `open_external` on `meetings_repo`), "Done" (dismisses wizard, → ML-0).
- **Side effect on entry**: Rust writes `~/.tmi/config.yaml` from collected wizard state, runs `tmi init --meetings-repo <path-from-wizard>` (path defaults to `%LOCALAPPDATA%\TangerineMeeting\meetings\`), sets two env vars on the user's account (`DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`) via Windows Registry `HKCU\Environment`, broadcasts `WM_SETTINGCHANGE` so already-running shells pick up. [design-call: env vars in registry, not in config file, because INTERFACES.md §3 mandates `_env` field pattern. App writes the env var name into config and the actual secret into the registry.]
- **Transitions out**: ML-0 or NM-0.

### ML-0 Meetings list (home)

- **When**: After SW-5, on every subsequent app launch (when config valid).
- **Reads**: `meetings_repo/meetings/*/meeting.yaml` + `status.yaml` for each. Watches dir via `notify` crate; refreshes on change.
- **Layout**: top bar with "+ New Meeting" button (right-aligned, primary tangerine), search field (left), filter dropdown (state). Below: vertical list of meeting cards. Each card shows: state pill (color-coded: created=gray, prepped=blue, live=green w/ pulse, ended=amber, wrapped=purple, reviewed=violet, merged=tangerine, failed_*=red), title, date, participant chips, transcript line count. Click card → MD-0 for that meeting.
- **Empty state**: "No meetings yet. Create your first." with CTA.
- **Actions**: New → NM-0; click card → MD-0.
- **Transitions out**: NM-0, MD-0, ST-0 (sidebar), Help.

### MD-0 Meeting detail

- **When**: User clicks a meeting in ML-0.
- **Reads**: full meeting dir for that ID — `meeting.yaml`, `status.yaml`, `intents/*.md`, `transcript.md`, `observations.md`, `summary.md`, `knowledge-diff.md`. Watches dir.
- **Layout**: header with meeting title, state pill, date, participants. Tabbed body:
  - **Intent** — one panel per participant (alias). Each shows the rendered markdown from `intents/<alias>.md`, with a "Re-run prep" action if `locked: false`. Missing intents shown as empty cards with "Run prep for <alias>" button → PR-0.
  - **Transcript** — live-tailing view of `transcript.md`. Monospace, line numbers, search.
  - **Observations** — flag list parsed from `observations.md`. Each flag is a card with severity-colored left border.
  - **Summary** — rendered `summary.md` (only visible when `state >= wrapped`).
  - **Diff** — rendered `knowledge-diff.md` block-by-block (only visible when `state >= wrapped`). Shows current review status per block (pending / approved / rejected / edited).
- **Actions** (top right, dynamic by state):
  - `created`/`prepped` → "Run prep" (→ PR-0), "Start meeting" (→ LV-0 via `tmi start`)
  - `live` → "Open Live panel" (→ LV-0), "Wrap meeting" (calls `tmi wrap`)
  - `ended` → "Wrap" (calls `tmi wrap`)
  - `wrapped` → "Review diff" (→ RV-0)
  - `reviewed` → "Apply" (→ AP-0 via `tmi apply`)
  - `merged` → "Open in Claude Code" (opens target_repo in detected editor)
  - `failed_*` → "Retry" (calls `tmi <cmd> --retry`), "Show debug" (opens `.tmi/*.log`)
- **Transitions out**: PR-0, LV-0, RV-0, AP-0, ML-0 (back).

### NM-0 New meeting

- **When**: User clicks "+ New Meeting" or `Ctrl+N`.
- **Reads**: `~/.tmi/config.yaml` (for team list and adapter list).
- **Layout**: centered modal card. Fields: Title (text, required), Scheduled at (datetime picker, optional), Participants (multi-select chip from `team[]`, defaults to all), Target adapter (dropdown if >1 adapter; hidden if exactly one). "Cancel" + "Create meeting" buttons.
- **Validation**: title non-empty + slugifies to `[a-z0-9-]+`; ≥ 1 participant.
- **Action on Create**: invokes `run_tmi("new", [title, "--participants", aliases, ...])`. On exit_code 0, parses meeting ID from stdout last line, navigates to MD-0 for that meeting.
- **Transitions out**: MD-0 (success) or stays open with error toast (failure).

### PR-0 Prep (per member)

- **When**: User clicks "Run prep" on MD-0.
- **Reads**: streams stdout from `tmi prep <id> --alias <alias>` subprocess line-by-line.
- **Layout**: chat-style transcript pane (left, 60%) + sidebar (right, 40%) showing intent skeleton being filled in (topics list, populated as observer extracts them). Bottom: text input (multiline, Cmd/Ctrl+Enter to send), and "Done" button (sends literal `done` to subprocess stdin to lock intent).
- **Actions**:
  - User types message → app pipes to subprocess stdin via `run_tmi_send_stdin` event.
  - Stdout token-streamed back to UI via `tmi:stdout:<run_id>` event.
  - On subprocess exit 0 → reads `intents/<alias>.md`, navigates back to MD-0.
  - On subprocess exit ≠ 0 → shows error banner with "Retry" and "Open log" actions.
- **Transitions out**: MD-0.

### LV-0 Live meeting

- **When**: After `tmi start` succeeds, or user clicks "Open Live panel" on a `live` meeting.
- **Reads**: tails `transcript.md` and `observations.md` for the live meeting; subscribes to status.yaml changes.
- **Layout**: split pane.
  - **Left (60%)** — transcript live-tail. Lines render as they arrive. Speaker alias colored chip + timestamp + text. Auto-scroll to bottom unless user scrolls up (lock indicator).
  - **Right (40%)** — observer flags panel. New flags fade in from top with severity color. Each flag clickable → scrolls transcript to referenced line range.
- **Top bar**: state pill ("LIVE" with pulsing dot), participant count, transcript line count, elapsed time. "Stop meeting" button (red) → confirms then runs `tmi wrap`.
- **Bottom bar**: bot status ("Bot connected · channel: General · reconnects: 0") and observer status ("Observer running · last poll: 14s ago"). Errors from `status.yaml.errors[]` shown as toast.
- **Transitions out**: MD-0 (after wrap completes, auto-navigates to summary tab).

### RV-0 Review

- **When**: User clicks "Review diff" on MD-0 with state=`wrapped`.
- **Reads**: `knowledge-diff.md` parsed by `tmi review --json` (CLI subcommand extension we ship in v1.5 — see §4.4 below).
- **Layout**: full-width split. Left (40%) = block list with status icons (●pending ✓approved ✗rejected ✎edited). Right (60%) = current block detail showing target file path, action, reason, transcript refs (clickable → opens transcript at line in MD-0), and the diff body in syntax-highlighted view. Action bar at bottom right: `[A]pprove` `[R]eject` `[E]dit` `[S]kip` `[Q]uit` (matches CLI keybindings).
- **Edit mode**: clicking Edit (or `e`) opens the diff body inline in a Monaco editor. Save → re-validates as a diff block, stores edited version into status.yaml.
- **Actions**: each decision invokes `run_tmi("review", ["--meeting-id", id, "--block-id", n, "--decision", "approve|reject|edit", "--body-path", tmpfile])`. Writing back to status.yaml is the CLI's job, not the app's.
- **Transitions out**: MD-0 once all blocks decided OR user clicks Done; AP-0 if user clicks "Apply now".

### AP-0 Apply status

- **When**: User clicks "Apply" on MD-0 with state=`reviewed`.
- **Reads**: streams `tmi apply <id>` output. After completion, reads `status.yaml.apply.commit_sha`.
- **Layout**: progress card. Steps: "Validating target repo" → "Writing files" → "Staging" → "Committing". On success: green check + "Applied 3 files · commit `<sha>` in `<target_repo>`. Run `git push` from the target repo to publish." Includes "Open in terminal" button (opens new shell at target_repo) and "Open in Claude Code" button.
- **Failure**: shows the specific failure (git conflict per INTERFACES.md §10.5) with remediation text and "Retry" button → calls `tmi apply --retry`.
- **Transitions out**: MD-0.

### ST-0 Settings

- **When**: Sidebar Settings tab, or `Ctrl+,`.
- **Reads**: `~/.tmi/config.yaml`.
- **Layout**: tabbed:
  - **General** — meetings_repo path (file picker), default TZ, log level.
  - **Discord** — bot token (re-issuable, masked), guild ID.
  - **Whisper** — API key (re-issuable, masked), model, chunk seconds slider (5–30).
  - **Claude** — CLI path, default timeout.
  - **Adapters** — list of `output_adapters[]` with add/edit/remove.
  - **Team** — same UI as SW-4.
  - **About** — version, "Check for updates" button, "Export Debug Bundle" (per §11), open-source licenses.
- **Actions**: every save invokes `set_config({yaml})` IPC which validates, writes config atomically, and emits `config-changed` event the store listens to.
- **Transitions out**: any sidebar destination.

---

## §4 IPC Protocol

This is the heart of the app. Every Tauri command, every event, every subprocess flag is locked here. Bound by both INTERFACES.md (CLI surface) and Tauri 2.x conventions.

### 4.1 Tauri commands (Rust → invokable from React)

All commands return `Result<T, AppError>`. `AppError` shape: `{ kind: "user"|"config"|"external"|"git"|"internal", code: string, detail: string }` (mirrors CLI exit-code taxonomy).

**Process commands**:

```ts
// Run a tmi subcommand. Returns a run_id to subscribe to events.
invoke("run_tmi", {
  subcommand: "prep" | "new" | "start" | "wrap" | "review" | "apply" | "list" | "status" | "init",
  args: string[],            // appended after subcommand
  meeting_id?: string,
  cwd?: string,              // defaults to meetings_repo
}): Promise<{ run_id: string }>;

// Subscribe in React via window.__TAURI__.event.listen(`tmi:stdout:${run_id}`, ...)
// Events emitted:
//   tmi:stdout:<run_id> { line: string, ts: string }
//   tmi:stderr:<run_id> { line: string, ts: string }
//   tmi:exit:<run_id>   { code: number, signal: string | null }

invoke("run_tmi_send_stdin", { run_id: string, text: string }): Promise<void>;
invoke("run_tmi_kill", { run_id: string, signal: "TERM"|"KILL" }): Promise<void>;

// Bot lifecycle (separate from `tmi start` because bot can outlive a single CLI run)
invoke("start_bot", { meeting_id: string, dry_run: boolean }): Promise<{ pid: number }>;
invoke("stop_bot", { meeting_id: string }): Promise<void>;
invoke("bot_status", { meeting_id: string }): Promise<{ pid: number | null, voice_channel_id: string | null }>;
```

**Filesystem commands**:

```ts
invoke("read_meeting", { meeting_id: string }): Promise<MeetingState>;
// MeetingState bundles meeting.yaml + status.yaml + intent file metadata + line counts.
// Full file bodies fetched separately to keep this lightweight.

invoke("read_meeting_file", { meeting_id: string, file: "transcript"|"observations"|"summary"|"knowledge-diff", offset?: number, limit?: number }): Promise<string>;
invoke("list_meetings", { state_filter?: string, since?: string }): Promise<MeetingListItem[]>;
invoke("tail_file", { path: string }): Promise<{ tail_id: string }>;
// Emits event `fs:tail:<tail_id>` { line: string } per appended line.
invoke("untail_file", { tail_id: string }): Promise<void>;

invoke("watch_meeting", { meeting_id: string }): Promise<{ watch_id: string }>;
// Emits event `fs:meeting-changed:<watch_id>` { file: string, kind: "modify"|"create"|"remove" }.
invoke("unwatch_meeting", { watch_id: string }): Promise<void>;
```

**Config commands**:

```ts
invoke("get_config"): Promise<ConfigYaml>;
invoke("set_config", { yaml: string }): Promise<void>;
// Validates against INTERFACES.md §3 schema; on success, atomic-renames yaml file and emits `config-changed`.
invoke("get_secret", { name: "DISCORD_BOT_TOKEN"|"OPENAI_API_KEY" }): Promise<string | null>;
// Reads from HKCU\Environment on Windows; returns null if unset.
invoke("set_secret", { name: string, value: string }): Promise<void>;
```

**System commands**:

```ts
invoke("open_external", { url: string }): Promise<void>;     // OS default browser/handler
invoke("open_in_editor", { path: string, line?: number }): Promise<void>;
// Detects VS Code / IntelliJ; falls back to OS default.
invoke("show_in_folder", { path: string }): Promise<void>;
invoke("system_notify", { title: string, body: string }): Promise<void>;
invoke("export_debug_bundle", { dest_path: string }): Promise<{ zip_path: string, file_count: number }>;
invoke("check_updates"): Promise<{ available: boolean, version: string | null, notes: string | null }>;

// Wizard-specific
invoke("detect_claude_cli"): Promise<{ found: boolean, path: string | null, version: string | null }>;
invoke("validate_target_repo", { path: string }): Promise<{ ok: boolean, has_claude_md: boolean, has_knowledge: boolean, has_cursorrules: boolean, error?: string }>;
invoke("validate_whisper_key", { key: string }): Promise<{ ok: boolean, error?: string }>;
invoke("poll_discord_bot_presence", { token: string }): Promise<{ guilds: { id: string, name: string }[] }>;
```

### 4.2 Python subprocess spawning (from Rust)

- Binary: `resources/python/python.exe` (Windows) or `resources/python/bin/python` (Mac/Linux). Resolved at app startup via Tauri's `Manager::path().resource_dir()`.
- Invocation: `python -m tmi.cli <args>`. **Never** rely on PATH.
- Environment: app inherits user env, then **overrides** `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY` from Windows registry (so the user need not restart shell for changes to take effect).
- `cwd`: defaults to `meetings_repo`; `tmi init` runs in user's home.
- Stdout: line-buffered, captured by Rust `BufReader`, each line emitted as `tmi:stdout:<run_id>` event. UTF-8; on decode error, emit raw bytes hex-encoded with stream type `binary`.
- Stderr: same pipeline, `tmi:stderr:<run_id>`.
- Stdin: piped. `run_tmi_send_stdin` writes UTF-8 + newline + flush.
- Exit: `tmi:exit:<run_id>` event with exit code; Rust process handle dropped.
- Concurrency: at most one `tmi prep` per meeting at a time (enforced by INTERFACES.md §10.6 lock); the app refuses overlapping spawns and surfaces "Another prep is running" toast.

### 4.3 Node bot subprocess spawning (from Rust)

- Binary: `resources/bot/tangerine-meeting-bot.exe` (single-file via `pkg --targets node20-win-x64`). [design-call: chose `pkg` over Node SEA — SEA still requires Node binary alongside, defeats single-file goal as of Apr 2026.]
- Invocation: `bot.exe --meeting-id <id> --meeting-dir <abs> --config <abs>` exactly as INTERFACES.md §5.1 mandates.
- Lifecycle: `start_bot` returns immediately with PID. Bot writes `status.yaml.bot.pid` itself (per INTERFACES.md §5.4); Rust trusts the file. PID monitor in Rust polls every 30s; if bot PID dies and `status.yaml.bot.pid != null`, Rust nullifies it and emits `bot:crashed` event.
- Shutdown: `stop_bot` sends SIGTERM (Windows: `GenerateConsoleCtrlEvent` with CTRL_BREAK). 10s grace, then SIGKILL. App quit also signals all bots gracefully.

### 4.4 CLI extension required for app

The app needs ONE small extension to the v0.1 CLI: machine-readable review output. Required so RV-0 can render diff blocks without re-parsing markdown.

```
tmi review <id> --json [--block-id <n>] [--decision approve|reject|edit] [--body-path <path>]
```

- Without `--decision`: outputs `knowledge-diff.md` parsed into JSON `{ blocks: DiffBlock[] }` (DiffBlock per INTERFACES.md §7.1).
- With `--decision`: applies the decision to the named block, updates `status.yaml.review.*`, exits 0. Equivalent to one keystroke in the interactive review.

This extension is **additive** to v0.1; the interactive `tmi review` (no `--json`) keeps working unchanged. T1–T6 should coordinate with the D0–D5 CLI agents to ship this in CLI v0.1.1 (not v1.0). [design-call: this is the only behavior change on the CLI side; all other app needs are read-only file access.]

---

## §5 Setup Wizard Flow (the high-leverage UX)

Target: **<2 minutes** end-to-end on the Discord bot step for a non-technical user. Today's CLI flow (per `SETUP.md`) takes 5–8 minutes mostly because of Developer-Portal navigation guesswork.

### SW-1.1 — Open Developer Portal

- **Heading**: "Step 1 of 4 — Create your Discord bot."
- **Body**: "Discord requires every bot to have an 'application'. We'll walk you through it." Two screenshots side-by-side (annotated with red circles): (a) Developer Portal homepage with "New Application" button highlighted; (b) the application creation modal.
- **CTA**: "Open Developer Portal" → `open_external("https://discord.com/developers/applications")`.
- **After click**: button text changes to "Opened. Continue when ready →"; "Continue" button enables.

### SW-1.2 — Paste bot token

- **Heading**: "Paste your bot token."
- **Body**: "In your new application, click 'Bot' in the left sidebar, then 'Reset Token' (or 'Copy' if it's a fresh one). Paste it below." Annotated screenshot of the Bot tab with the token field highlighted.
- **Input**: masked text field (eye-toggle to reveal). Validation: starts with one of the Discord bot token patterns (the leading 24-char base64 segment + dots), length 50–80. [design-call: don't hardcode prefix; Discord rotates the prefix scheme.]
- **On Continue**: validates by calling `GET https://discord.com/api/v10/users/@me` with `Authorization: Bot <token>`. 200 → bot exists, advance. 401 → "Token invalid — copy it again." On success, stores token in memory.

### SW-1.3 — Invite bot to server

- **Heading**: "Add the bot to your team's server."
- **Body**: "Click below to invite. We've pre-filled the right permissions." Two side-by-side cards:
  1. URL display + "Copy" button + "Open invite →" button. URL: `https://discord.com/api/oauth2/authorize?client_id=<auto-detected>&scope=bot%20applications.commands&permissions=2150629888`. The `client_id` is the bot's application ID (auto-fetched from the `users/@me` response in SW-1.2).
  2. Status pill: "Waiting for bot to join your server..." with a spinning indicator. Polls `GET /users/@me/guilds` every 5 seconds (rate-limit-aware: 50 req/sec global, this is fine). On first guild detected → pill turns green "Bot is in <server-name>! 🎉" and "Continue" enables.
- **Skip option**: small "I'll add it later" link advances with `guild_id = null`. The CLI tolerates this per INTERFACES.md §3 (`guild_id` is optional).

### SW-1.4 — Get server ID

- **Heading**: "What server should we listen to?"
- **Body**: "If your bot is in multiple servers, pick which one Tangerine Meeting should respond in." If polling in 1.3 detected exactly one guild, this step is auto-filled and skipped. Otherwise: dropdown of detected guilds (id + name), or manual entry field.
- **Help**: tooltip with text "Don't see your server? Make sure Developer Mode is on (Settings → Advanced → Developer Mode), then right-click your server icon and Copy Server ID."
- **Outputs**: `discord.guild_id`.

### SW-2 through SW-5

Per §3 above. SW-2 has live-validation against the OpenAI API; SW-3 has a folder picker with feature detection; SW-4 has CSV-paste shortcut for users with many team members. SW-5 commits all collected state.

### Wizard back-button + persistence

- Back navigates one sub-step at a time. State accumulates in a `wizard` Zustand slice; closing the wizard mid-flow (Quit confirmation) **discards** the slice. [design-call: don't persist half-finished wizards. The whole flow is <5 minutes; resume-from-where-you-were is more code than re-entering 4 fields.]
- All inputs are echoed at SW-5 in a "Review your settings" summary card before final write. User clicks "Looks good — finish" to commit; Back goes to whichever step they want to fix.

---

## §6 State Management (React side)

### 6.1 Library choice

**Zustand** (NOT Redux, NOT Recoil). Rationale: smallest API surface, zero boilerplate, great TypeScript inference, devtools available. `react-query` is NOT used in v1.5 — every fetch is a Tauri command and we don't need cache invalidation strategies because the FS watcher pushes changes.

### 6.2 Slices

```ts
// app/src/store/index.ts
type Store = {
  config: ConfigSlice;
  meetings: MeetingsSlice;
  currentMeeting: CurrentMeetingSlice;
  wizard: WizardSlice;
  ui: UiSlice;
};

type ConfigSlice = {
  yaml: ConfigYaml | null;
  loading: boolean;
  error: AppError | null;
  reload: () => Promise<void>;
  save: (yaml: string) => Promise<void>;
};

type MeetingsSlice = {
  list: MeetingListItem[];           // populated by list_meetings, refreshed by FS watcher
  filter: { state?: string; query?: string };
  refresh: () => Promise<void>;
};

type CurrentMeetingSlice = {
  meetingId: string | null;
  state: MeetingState | null;        // from read_meeting
  transcriptTail: string[];          // last N lines from tail_file
  observationsTail: ObservationFlag[];
  watchId: string | null;
  open: (id: string) => Promise<void>;
  close: () => void;
};

type WizardSlice = {
  step: 0 | 1 | 1.1 | 1.2 | 1.3 | 1.4 | 2 | 3 | 4 | 5;
  collected: Partial<WizardData>;
  next: () => void;
  back: () => void;
  setField: (key, value) => void;
  finish: () => Promise<void>;       // writes config + secrets, runs tmi init
};

type UiSlice = {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  activeRunIds: string[];
  toasts: Toast[];
};
```

### 6.3 Sync rules

- **FS watcher → store**: Rust emits `fs:meeting-changed:<watch_id>` when files in the watched meeting dir change. Store debounces 200ms and re-runs `read_meeting`.
- **Config watcher**: similar, 1 watcher on `~/.tmi/config.yaml`. On `config-changed` event, store reloads.
- **No backend HTTP**: all state lives in local files; refresh is push (FS watcher) not pull.

---

## §7 Theming + Design Language

### 7.1 Colors (CSS custom properties)

Mirrors `tangerine-learn` for visual consistency. Defined in `app/src/styles/tokens.css`:

```css
:root {
  --ti-orange-500: #CC5500;
  --ti-orange-400: #E06A1A;
  --ti-orange-100: #FFE8D6;
  --ti-navy-900: #1A1A2E;
  --ti-navy-700: #2A2A4E;
  --ti-paper-100: #FAF6EE;
  --ti-paper-200: #F0EBDC;
  --ti-text-primary: #1A1A2E;
  --ti-text-secondary: #4A4A5E;
  --ti-text-tertiary: #7A7A8A;
  --ti-border-default: #D4CFC0;
  --ti-border-faint: #E8E3D5;
  --ti-success: #2D8659;
  --ti-warn: #B8860B;
  --ti-error: #B83232;
  --ti-state-live: #2D8659;
  --ti-state-failed: #B83232;
}

[data-theme="dark"] {
  --ti-paper-100: #14141C;
  --ti-paper-200: #1E1E2A;
  --ti-text-primary: #FAF6EE;
  --ti-text-secondary: #C4C0B5;
  --ti-text-tertiary: #8A8A95;
  --ti-border-default: #353545;
  --ti-border-faint: #2A2A3A;
}
```

### 7.2 Typography

```css
--ti-font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;
--ti-font-serif: "Charter", "Iowan Old Style", Georgia, serif;  /* H1/H2 */
--ti-font-sans: "Inter", -apple-system, "Segoe UI", sans-serif;  /* body, UI */
```

Headings serif, body sans, code/data mono. UI labels (sidebar items, button labels) sans 13px. Caps + 0.18em letter-spacing for section labels (mirrors tangerine-learn).

### 7.3 Component library

**shadcn/ui** with Tangerine color overrides. [design-call: shadcn over raw Radix because shipped variants save days; we override via Tailwind theme + the CSS variables above. Customizing 6 components (Button, Card, Dialog, Input, Tabs, DropdownMenu) is cheaper than rolling our own from Radix.]

### 7.4 Spacing + radii

- Base unit: 4px. Tailwind's default scale.
- Card radius: 8px; button radius: 6px; pill radius: 999px.
- Border: 1px solid `var(--ti-border-default)`; on dark mode, automatically swaps via the CSS variable.

### 7.5 Animations

- Hover/focus: `150ms ease-out` color transitions only.
- Modal/wizard enter: `200ms ease-out` opacity + translateY 8px.
- LIVE pulse dot: 2s ease-in-out infinite scale 0.9–1.1.
- **No marketing flourishes.** No spring physics, no parallax, no scroll-triggered confetti. The app is a tool.

### 7.6 Dark mode

Supported via `data-theme` attribute on `<html>`. Default to light for v1.5.0-beta. `prefers-color-scheme` honored when `theme === "system"`. All custom colors come from CSS variables so dark mode is a token swap, not a parallel stylesheet.

---

## §8 Process Lifecycle + Crash Recovery

### 8.1 App startup

1. Rust boot: read window state, register IPC handlers, register `Ctrl+N` etc. global accelerators.
2. Single-instance check (Tauri plugin). If second instance, focus the existing window and exit.
3. Read `~/.tmi/config.yaml`. If missing or `schema_version` invalid → wizard. If newer schema_version than app supports → modal "This config was written by a newer Tangerine Meeting. Update the app from <download URL>."
4. **Orphan scan**: walk `meetings_repo/meetings/*/status.yaml`. For any meeting with `state == live` and `bot.pid != null`:
   - Check if PID is alive (Windows: `OpenProcess`; cross-platform: `sysinfo` crate).
   - If dead: set `bot.pid = null`, append `errors[]` entry `{component: "bot", code: "orphan_detected_at_startup"}`, transition state per INTERFACES.md §10.2 (→ `failed_bot` after 3 reconnect failures, but we count "previous run died" as 3).
   - If alive: trust it, attach event listeners, render LIVE state in UI.
5. Same orphan scan for `observer.pid`.
6. Load meetings list → render ML-0.

### 8.2 App shutdown (user closes window or quits)

1. UI shows confirmation if any meeting is `live`: "Stop your live meeting? The bot will leave Discord and your transcript will be wrapped." Buttons: Stop and quit / Keep running and quit / Cancel.
2. "Stop and quit" → invoke `tmi wrap <id>` synchronously (with 30s timeout), then quit.
3. "Keep running and quit" → emit unbinding events to Rust, leave bot + observer running as detached children (per INTERFACES.md they survive parent exit). Update `status.yaml.errors[]` with `{code: "app_exited_during_live", at: now}` so the user is reminded next launch.
4. Default close (no live meeting): release locks, drop watchers, exit.

### 8.3 Crash detection

- PID monitor task in Rust polls every 30s for every tracked subprocess.
- On unexpected death: Rust appends `{component, code: "subprocess_crashed", detail, at}` to `status.yaml.errors[]` (read-modify-write, atomic rename per INTERFACES.md §2.7), emits `subprocess:crashed` event to UI which surfaces a toast.
- INTERFACES.md §10 retry rules apply unchanged — Rust reads them off the CLI's behavior and just reflects them in the UI.

### 8.4 Live meeting close confirmation

User clicks "Stop meeting" in LV-0 → modal: "Wrap meeting now? This will: leave the Discord voice channel, stop the observer, generate summary + diff." Buttons: Wrap now (primary), Just stop (no wrap, leaves state=`ended`), Cancel.

---

## §9 Packaging + Distribution

### 9.1 Tooling

- **Tauri 2.x** (≥ 2.1.0 as of April 2026).
- **Rust** 1.78+.
- **Node** 20.x for dev tooling (Vite, TS compile, shadcn).
- **PyInstaller** 6.x for Python freeze.
- **pkg** 5.x for Node bot freeze (with `--targets node20-win-x64`).
- **NSIS** for Windows installer (Tauri's default Windows bundler). [design-call: NSIS over WiX/MSI because installer size is ~30% smaller and we don't need group-policy deployment for a beta.]

### 9.2 Build pipeline

```
1. Build Python:
   cd src && python -m PyInstaller --onedir --name tmi-frozen tmi/cli.py
   → dist/tmi-frozen/  →  copy to  app/resources/python/

2. Build bot:
   cd bot && npm run build:pkg
     (pkg src/index.js -t node20-win-x64 -o tangerine-meeting-bot.exe)
   → tangerine-meeting-bot.exe  →  copy to  app/resources/bot/

3. Build app:
   cd app
   npm run tauri build
   → app/src-tauri/target/release/bundle/nsis/Tangerine Meeting Setup.exe
   → app/src-tauri/target/release/Tangerine Meeting.exe
```

`tauri.conf.json` `bundle.resources` includes `resources/python/**`, `resources/bot/**`, `resources/icons/**`.

### 9.3 Installer behavior (Windows NSIS)

- Default install path: `%LOCALAPPDATA%\Programs\TangerineMeeting\`. Per-user install, no UAC prompt. [design-call: per-user install over per-machine to avoid signing requirement for v1.5.0-beta.]
- Optional desktop shortcut, mandatory Start Menu entry under "Tangerine".
- Uninstaller registered in Add/Remove Programs.
- First-run side effects: creates `%LOCALAPPDATA%\TangerineMeeting\` for logs + window state. Meetings repo path is user-chosen via SW-3.

### 9.4 Installer size

Target: 130–170 MB. Components (rough estimates):
- Tauri Rust binary: ~15 MB
- React UI bundle: ~3 MB
- Python freeze: ~50 MB (Python 3.11 minimal + claude-cli + tmi deps)
- Node bot freeze: ~70 MB (`pkg` bundles full Node)
- Icons + fonts: ~5 MB
- NSIS overhead: ~3 MB

If we blow past 170 MB: drop dark-mode font weights, switch Node freeze to a slimmer runtime. Hard cap: 200 MB.

### 9.5 Code signing

- v1.5.0-beta: **unsigned**. SmartScreen will warn. SETUP.md documents the "right-click → Properties → Unblock" workaround.
- v1.5.0 GA: EV code signing certificate (~$300/yr from DigiCert or SSL.com via SafeNet token). Apple notarization for Mac at the same time.

### 9.6 Mac/Linux

- Tauri bundles `.app` and `.AppImage` at build time. CI builds them but does **not** block release on them.
- Mac unsigned `.app` requires user to right-click → Open. Document in SETUP.md but not promoted.
- Linux `.AppImage` and `.deb` work out of the box; ship as "experimental" in v1.5.0.

---

## §10 Auto-Update

- Tauri updater plugin. Update source: GitHub Releases on `Tangerine-Intelligence/tangerine-meeting-live`.
- Update manifest at `https://github.com/Tangerine-Intelligence/tangerine-meeting-live/releases/latest/download/latest.json`. Manifest signed with Tauri's update key (key kept in `Tangerine-Intelligence` org's Actions secrets).
- Check on startup + every 24h (background task).
- User experience: non-blocking toast "Version 1.5.1 available — what's new" → click → modal with changelog → Update now / Later / Skip this version.
- v1.5.0-beta can ship without functional auto-update (manual download is fine for ~10 dogfood users). But the manifest infrastructure ships at v1.5.0-beta so v1.5.1 can auto-update beta users. [design-call: ship the plumbing now, even if no update exists yet, to avoid migration pain later.]

---

## §11 Logs + Debug

### 11.1 Log paths

- App (Rust + React): `%LOCALAPPDATA%\TangerineMeeting\logs\app.log`. Rotated at 10 MB, keeps last 5.
- Python CLI: `%LOCALAPPDATA%\TangerineMeeting\logs\tmi.log`. Same rotation. The CLI's own `logging.file` config defaults to this path when launched by the app.
- Bot per meeting: `<meeting-dir>/.tmi/bot.log` (per INTERFACES.md, unchanged).
- Observer per meeting: `<meeting-dir>/.tmi/observer.log`.

### 11.2 Log levels

Controlled by Settings → General → Log level. Default `info`. Debug includes IPC trace, FS watcher events, subprocess line-by-line capture.

### 11.3 Export Debug Bundle

Settings → About → "Export Debug Bundle":
1. Open save dialog (default name `tangerine-meeting-debug-<YYYY-MM-DD>.zip`).
2. Rust collects: app log, tmi log, sanitized config (tokens replaced with `***REDACTED***`), `status.yaml` of last 5 meetings, system info (OS version, app version, RAM).
3. Zips into chosen path.
4. Toast "Debug bundle saved. Email to daizhe@berkeley.edu with a description of the issue."

### 11.4 Sanitization rules

- `discord.bot_token_env` value → redacted.
- `whisper.api_key_env` value → redacted.
- Any line in any log matching `(token|key|secret)\s*[:=]\s*['"]?([A-Za-z0-9-_]{20,})` → group 2 replaced with `***`.
- `meetings_repo` path → preserved (debugging needs it).

---

## §12 Testing Strategy

### 12.1 Rust unit tests

`cargo test` on Tauri command handlers. Mock the subprocess layer behind a `ProcessRunner` trait so tests don't actually spawn Python. Coverage target: every command has a happy-path + one error-path test. Estimate: ~30 tests.

### 12.2 React component tests

Vitest + React Testing Library on individual screens. Mock `invoke` via Tauri's mock module. Coverage target: every screen renders without error in three states (loading, success, error).

### 12.3 E2E (Playwright)

Five scenarios, each runs against the built `Tangerine Meeting.exe`:

1. **First-run wizard**: launches app, walks SW-0 → SW-5 with deterministic inputs, asserts `~/.tmi/config.yaml` written and matches expected schema.
2. **Full meeting cycle**: with `TMI_BOT_MODE=stub` + `TMI_CLAUDE_MODE=stub` (per INTERFACES.md §12), runs new → prep → start → wrap → review → apply. Asserts target repo gets a commit.
3. **Settings round-trip**: open ST-0, change `chunk_seconds` from 10 to 15, save, reload app, verify persisted.
4. **Meetings list state**: pre-seed `meetings_repo` with 3 meetings in different states; assert ML-0 renders 3 cards with correct state pills; click one; verify MD-0 loads.
5. **Live close grace**: start a meeting (stub bot), quit app via window close, confirm "Stop and quit" path — verify wrap ran and state ended.

### 12.4 No real Discord / Whisper in CI

All tests use the stub modes from INTERFACES.md §12. CI never holds API tokens.

### 12.5 Manual smoke matrix (per release)

Pre-release checklist (T6 owns):
- Install on clean Win11 VM → wizard completes → first meeting works end-to-end with real Discord + real Whisper.
- Uninstall removes all files except `meetings_repo/` (which is user data).
- Auto-update from v1.5.0-beta to a v1.5.0-beta+1 mock release.

---

## §13 Windows Specifics

### 13.1 Tauri config

`app/src-tauri/tauri.conf.json` `bundle.windows`:

```json
{
  "certificateThumbprint": null,
  "digestAlgorithm": "sha256",
  "timestampUrl": "",
  "wix": null,
  "nsis": {
    "installMode": "perUser",
    "installerIcon": "icons/installer.ico",
    "headerImage": "icons/installer-header.bmp",
    "sidebarImage": "icons/installer-sidebar.bmp",
    "license": "../../LICENSE",
    "displayLanguageSelector": false
  }
}
```

### 13.2 Single-instance lock

Tauri `single-instance` plugin. On second launch with the same user, focus the existing window with the `meeting_id` deep link if present.

### 13.3 Locale detection

Rust reads `GetUserDefaultUILanguage()`. If Chinese (zh-CN, zh-TW, zh-HK): wizard offers "中文 / English" toggle (cosmetic only — UI strings are English-only in v1.5.0-beta; toggle just sets a flag for v1.5.1 localization). [design-call: detect-but-don't-translate so Chinese users see we know they exist; localization is a v1.5.1 dedicated agent task.]

### 13.4 Defender + SmartScreen

Document in SETUP.md the unblock workaround for the unsigned beta. Provide a fallback for users on tightly-managed corporate devices: "If your IT blocks unsigned apps, ask them to whitelist `Tangerine Meeting.exe` SHA-256 `<sha-from-release>`. Or wait for v1.5.0 GA in a few weeks."

### 13.5 Path quirks

- Always normalize via `std::path::Path` then convert to POSIX with forward slashes when calling Python CLI (which always uses `pathlib.Path`).
- Long paths (>260 chars): enable Win10/11 long-path support via app manifest. Meeting IDs can produce paths near the limit.
- `meetings_repo` containing spaces or non-ASCII: tested in CI; Rust quotes correctly when building command lines.

---

## §14 Non-Goals (v1.5.0-beta scope, do NOT build)

- ❌ Mobile (iOS/Android).
- ❌ Mac/Linux signed builds. Builds work; signing deferred to GA.
- ❌ Backend/cloud service. Local-first remains.
- ❌ Multi-team UI. v0.1 CLI is single-team-per-config; the app inherits.
- ❌ Chat / calendar features. Those are TGC / TCal, future TTI products.
- ❌ Chinese UI localization. English-only first release; locale detection only.
- ❌ System-wide hotkeys outside the window. App-scoped only.
- ❌ Screen reader / a11y beyond OS defaults. Will land in v1.6 with proper audit.
- ❌ Custom onboarding for non-Tangerine teams. The wizard assumes Discord + Claude Code + git target. Cursor / Aider adapters land in v1.5.1+.
- ❌ Telemetry / analytics. We track nothing; debug bundle is the only data path back to us, and only when user explicitly clicks Export.

---

## §15 Milestones + Gates (T1–T6)

Six parallel agents. T1–T2 ship features, T3–T4 ship infra, T5–T6 ship release.

### T1 — Setup wizard + config (Week 1 gate)

- All of §3 SW-0 through SW-5.
- All of §5.
- `get_config` / `set_config` / `get_secret` / `set_secret` IPC.
- `detect_claude_cli` / `validate_target_repo` / `validate_whisper_key` / `poll_discord_bot_presence`.
- **Gate**: launch app on clean machine, wizard runs end-to-end, produces valid `~/.tmi/config.yaml`, env vars set in registry, `tmi --help` from packaged Python returns 0.

### T2 — Meetings + live + review + settings (Week 2 gate)

- ML-0, MD-0, NM-0, PR-0, LV-0, RV-0, AP-0, ST-0.
- All file-watching IPC; tail subscription; `run_tmi` with stdin.
- The CLI `--json` review extension (T2 coordinates with D2 on CLI side).
- **Gate**: New → prep → start → wrap → review → apply works inside the app, end-to-end, against a stubbed CLI then against the real CLI.

### T3 — Rust core + IPC + process lifecycle (Week 1–2, parallel)

- All commands in §4. Process spawner. PID monitor. FS watcher. Single-instance.
- Window state persistence. Global shortcuts. Tray (optional, deferred to T6 if behind).
- Crash recovery per §8.
- **Gate**: full IPC surface implemented and unit-tested; no UI required (T1/T2 wire it up).

### T4 — Packaging + Windows installer (Week 3 gate)

- PyInstaller build for Python; pkg build for bot.
- Tauri NSIS configuration; installer icons; SETUP.md updates.
- Installer size verification.
- **Gate**: `npm run tauri build` produces `Tangerine Meeting Setup.exe` <170 MB; running it on a fresh Win11 VM with no Python/Node installed, the app launches, and a smoke test (wizard → meeting → wrap) passes.

### T5 — CI + auto-update infrastructure (Week 4 gate)

- GitHub Actions: builds on every push to `main`, on tagged release publishes installers to Releases. Matrix Win/Mac/Linux (Win blocking, others informational).
- Tauri update key generation + storage in org Actions secrets.
- `latest.json` manifest produced at release time.
- **Gate**: tagging `v1.5.0-beta` produces a Release with installer + manifest; Tauri updater reads manifest correctly (verified by faking a v1.5.0-beta+1 release and checking the in-app prompt fires).

### T6 — Docs + demo + release (Week 4 gate)

- SETUP.md rewritten for the app (replaces CLI-focused walkthrough).
- README.md adds desktop install link.
- Demo GIF (60s) showing wizard → first meeting → diff applied. Hosted in repo `docs/assets/`.
- Release notes for v1.5.0-beta.
- **Gate**: published Release with downloadable `Tangerine Meeting Setup.exe`, SETUP.md walks a non-builder through install in <10 minutes, demo GIF embedded in README.

### Cross-team coordination

- T1 + T3: T1 cannot start UI work for IPC commands T3 hasn't shipped. T3 must publish a stubbed-but-typed IPC surface by end of week 1 day 2.
- T2 + D2 (CLI agent): the `tmi review --json` extension is shared work. D2 owns the CLI change; T2 owns consuming it. Sync at end of week 1.
- T4 + T5: T5's GitHub Actions builds the installer T4 produces locally. T5 reproducibility checks T4's local-build output against CI output to catch path/env divergence.
- T6 depends on everyone landing by end of week 4 day 2 to leave 3 days for docs polish + demo recording.

---

## Appendix A: Component → CLI command matrix

Quick reference — every UI affordance and the CLI invocation it triggers.

| UI surface | Command spawned | INTERFACES.md ref |
|---|---|---|
| SW-5 finish | `tmi init --meetings-repo <path>` | §4.1 |
| NM-0 Create | `tmi new <title> --participants ...` | §4.2 |
| MD-0 "Run prep" | `tmi prep <id> --alias <a>` | §4.3 |
| MD-0 "Start meeting" | `tmi start <id>` | §4.4 |
| MD-0 "Wrap meeting" / LV-0 Stop | `tmi wrap <id>` | §4.6 |
| RV-0 each block decision | `tmi review <id> --json --block-id <n> --decision <d>` | §4.7 + new --json |
| AP-0 Apply | `tmi apply <id>` | §4.8 |
| ML-0 list | `tmi list` (or direct FS read — both work) | §4.9 |
| ST-0 reload | `tmi status <id>` for active rows | §4.10 |
| AP-0 Retry / failed-state Retry | `tmi <cmd> --retry` | §9 retry rules |

## Appendix B: Decisions log

1. NSIS over MSI — smaller installer, no group-policy deployment needed for beta.
2. shadcn/ui over raw Radix — faster shipping; Tangerine theme via CSS variables.
3. `pkg` over Node SEA for bot freeze — single-file output as of April 2026 SEA limitations.
4. Per-user install path — avoids UAC prompt + signing requirement for unsigned beta.
5. Tray icon deferred to v1.5.1 — packaging complexity not worth it for dogfood beta.
6. CLI `tmi review --json` extension — only behavior change required on CLI side; everything else is read-only file access.
7. Discard half-finished wizards — resume logic is more code than re-entering 4 fields.
8. Locale detection but no zh-CN translation in v1.5.0-beta — show users we know about them; localization is a v1.5.1 dedicated agent task.
9. Env vars in Windows Registry, not config file — INTERFACES.md §3 mandates `_env` field; we honor it and store actual secrets in HKCU\Environment.
10. Zustand over Redux — smaller API, no boilerplate, no cache invalidation needed (FS watcher pushes changes).
11. Update manifest infrastructure in v1.5.0-beta even with no update — avoids migration pain when v1.5.1 needs to update beta users.
12. Single window, sidebar tabs — multi-window adds platform divergence (Windows/Mac differ on what "main window closed" means); revisit at v2.

---

**End of APP-INTERFACES.md.** If you change a contract here, update Appendix B and notify the other 5 parallel agents. If a contract here conflicts with INTERFACES.md, INTERFACES.md wins — fix it here first.
