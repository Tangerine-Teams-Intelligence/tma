# INTERFACES.md — Tangerine Meeting Assistant (TMA) v1

**Status**: Locked 2026-04-24
**Audience**: Three parallel implementation agents (Python CLI / Claude Code adapter / Discord bot). This is the contract. If something here is wrong, fix it here first, not in code.
**Companion docs**: `PLAN.md` (product spec), `README.md` (positioning).

This document specifies every cross-component boundary in TMA v1: file paths, schemas, command signatures, IPC, state transitions, failure semantics. A reader should be able to implement any single component without coordinating with the other two, as long as everyone obeys this file.

Conventions:
- All paths are POSIX-style. On Windows, the CLI normalizes via `pathlib.Path`.
- All timestamps are RFC 3339 with timezone offset. Default TZ: `Asia/Shanghai` (`+08:00`).
- All YAML uses 2-space indent, lowercase keys, `snake_case`.
- All schema versions are integers. v1 ships with `schema_version: 1` everywhere.
- `[design-call: X]` annotations mark places where PLAN.md left a question open and this doc made the call.

---

## §1 Component Map

```
┌────────────────────────────────────────────────────────────────────┐
│                       USER TERMINAL (Python)                       │
│                                                                    │
│   ┌─────────────────┐                                              │
│   │  tmi  (Typer)   │ ──── reads/writes ────►  meetings/<id>/      │
│   │  package:       │                          (filesystem schema) │
│   │  tangerine-     │                                              │
│   │  meeting-       │ ──── spawns ──────►  Observer Subprocess     │
│   │  assistant      │                      (`claude` CLI headless) │
│   │                 │                                              │
│   │  imports        │ ──── spawns ──────►  Discord Bot             │
│   │  tmi.adapters.  │                      (`node bot/dist/...`)   │
│   │  claude_code    │                                              │
│   └─────────────────┘                                              │
│            │                                                       │
│            └─► applies diffs to ───►  Target repo (CLAUDE.md, ...) │
└────────────────────────────────────────────────────────────────────┘
```

### Component ownership

| Component | Language | Lives in | Owns |
|---|---|---|---|
| `tmi` CLI | Python 3.11 + Typer | `src/tmi/` | All commands; meeting dir lifecycle; spawning observer + bot; review UI |
| Claude Code Output Adapter | Python module | `src/tmi/adapters/claude_code.py` | Read target repo ground truth; format diff blocks; apply approved diffs; commit (no push) |
| Observer Subprocess | `claude` CLI (headless) | invoked by CLI; prompts at `src/tmi/observer/prompts/` | Generating intents (prep), flag emission (observe), summary+diff (wrap) |
| Discord Bot | Node.js 20 + TypeScript + discord.js v14 | `bot/` (separate `package.json`) | Voice channel join, per-user audio capture, Whisper streaming, transcript writes, slash commands |
| Shared meeting dir | filesystem (git-versioned) | `meetings/<id>/` (location set by `tmi init`) | All inter-component IPC. No DB. No socket. |

### Communication is exclusively file-based.
- CLI ↔ Bot: bot reads `meeting.yaml`, writes `transcript.md` + `status.yaml`. CLI polls.
- CLI ↔ Observer: observer is a single-shot or long-poll subprocess; CLI feeds inputs via stdin and prompt files; observer writes outputs via stdout (CLI captures and persists) or directly to designated paths (see §6).
- CLI ↔ Adapter: in-process Python imports.

There is no HTTP, no socket, no message queue in v1. Every state change leaves a file behind.

---

## §2 Filesystem Schema (Single Source of Truth)

All artifacts live under `meetings/<id>/`. The meetings repo location is set in `~/.tmi/config.yaml` as `meetings_repo`.

### 2.0 Directory layout

```
meetings/
└── 2026-04-24-david-sync/
    ├── meeting.yaml            # immutable after `tmi new`
    ├── status.yaml             # mutated throughout lifecycle
    ├── intents/
    │   ├── daizhe.md
    │   ├── hongyu.md
    │   └── advisor.md
    ├── transcript.md           # append-only during meeting
    ├── observations.md         # append-only during meeting
    ├── summary.md              # written by wrap
    ├── knowledge-diff.md       # written by wrap
    └── .tmi/
        ├── bot.log             # bot stderr
        ├── observer.log        # observer stderr
        └── lock                # presence = a process holds the meeting
```

### 2.1 `meeting.yaml`

Written by `tmi new`. Treated as **immutable** afterwards (other commands read but never write). Format:

```yaml
schema_version: 1
id: 2026-04-24-david-sync           # required, must match dir name; format: YYYY-MM-DD-<slug>
title: "David sync — meeting product direction"   # required, free text
created_at: 2026-04-24T18:00:00+08:00              # required, RFC 3339
scheduled_at: 2026-04-24T19:00:00+08:00            # optional, RFC 3339
participants:                       # required, >=1
  - alias: daizhe                   # required, lowercase ASCII, used as filename
    display_name: "Daizhe Zou"      # required
    discord_id: "281234567890123456" # optional; if absent, member can still prep but bot won't label them
  - alias: hongyu
    display_name: "Hongyu Xu"
    discord_id: "291234567890123456"
target_adapter: tangerine-main      # required; references config.yaml output_adapters[].name
tags: [internal, weekly]            # optional, free-form list
```

Validation rules:
- `id` MUST equal directory basename.
- `id` MUST match regex `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`.
- Every `alias` MUST be unique within the file and match `^[a-z][a-z0-9_]*$`.
- `target_adapter` MUST resolve to a configured adapter at `tmi apply` time (not at `tmi new` time — adapter may be added later).

### 2.2 `intents/<alias>.md`

Written by `tmi prep`. One file per participant. Locked once `frontmatter.locked: true`. Format = YAML frontmatter + Markdown body.

```markdown
---
schema_version: 1
author: daizhe
created_at: 2026-04-24T18:30:00+08:00
locked: true
locked_at: 2026-04-24T18:35:00+08:00
turn_count: 7              # number of prep prompt turns it took
---

## Topics

### Topic 1: v1 scope lock
- **Type**: decision
- **Goal**: decide Discord-only vs Discord+Zoom for v1
- **Expected disagreement**: Hongyu may push for Zoom
- **My current stance**: Discord-only v1
- **Writeback target**: knowledge/session-state.md

### Topic 2: Weekly dogfood cadence
- **Type**: sync
- **Goal**: confirm Monday standups run through TMA
- **Expected disagreement**: none
- **My current stance**: start next Monday
- **Writeback target**: CLAUDE.md
```

Required body sections (in order): `## Topics` (>=1 topic). Each topic MUST have `Type`, `Goal`. Other bullets optional but observer expects them when present.

`Type` enum: `decision | sync | brainstorm | review | status_update | other`. [design-call: chose closed enum over freeform so wrap-mode can group topics; `other` is the escape hatch.]

### 2.3 `transcript.md`

Append-only during meeting, written by Discord bot. Plain text, no frontmatter (frontmatter would block append-only writes from a separate process). Line format:

```
[HH:MM:SS] <ALIAS>: <text>
```

Rules:
- Timestamp is wall-clock local time at the moment Whisper returned the chunk.
- `<ALIAS>` matches an alias in `meeting.yaml`, OR `GUEST:N` for unmapped Discord IDs (N = monotonic counter starting at 1 per meeting), OR `[STT_FAILED]` for Whisper failures (see §10).
- `<text>` is verbatim Whisper output, single-line. If Whisper returns multi-line, bot replaces newlines with `␤` (U+2424) so each transcript line maps to exactly one source chunk.
- Lines are written in arrival order, not start-of-speech order. [design-call: arrival order is what Whisper emits and reordering would require a buffer that defeats the live-tail use case.]
- Bot calls `fsync` after each write so observer's polling reads see consistent state.

Example:
```
[19:02:14] daizhe: 所以我们先只做 Discord 对吧？
[19:02:18] hongyu: 对，Zoom 等 v1.1。
[19:02:22] GUEST:1: 这个 Whisper 延迟感觉还行
[19:03:01] [STT_FAILED]: chunk_id=42 reason=timeout retries=3
```

### 2.4 `observations.md`

Append-only during meeting, written by observer (wrap mode also reads it). Markdown with one entry per observer flag.

```markdown
## [19:14:32] FLAG: ground_truth_contradiction
**Topic**: v1 scope
**Transcript ref**: L47-L52
**Detail**: Hongyu's "Zoom is necessary for v1" contradicts CLAUDE.md "Discord-only v1 scope".
**Severity**: medium

---

## [19:31:08] FLAG: agenda_drift
**Topic**: weekly dogfood cadence (intent: daizhe Topic 2)
**Transcript ref**: last addressed at L31, now L188
**Detail**: 12 minutes since last mention; meeting drifting to pricing.
**Severity**: low
```

`FLAG` enum (closed): `ground_truth_contradiction | agenda_drift | intent_unaddressed | intent_conflict | user_query`. `Severity` enum: `low | medium | high`.

Each entry begins with a level-2 heading `## [HH:MM:SS] FLAG: <type>` and ends with `---` separator (except the last). [design-call: heading-with-separator format chosen over JSONL because it's diff-friendly and humans will skim it.]

### 2.5 `summary.md`

Written by `tmi wrap`, one-shot output. Markdown.

```markdown
---
schema_version: 1
generated_at: 2026-04-24T20:15:00+08:00
meeting_id: 2026-04-24-david-sync
participants: [daizhe, hongyu]
duration_minutes: 47
---

# David sync — 2026-04-24

## Topics covered

### Topic 1: v1 scope lock
- **Outcome**: decided — Discord-only v1, Zoom at v1.1
- **Decided by**: daizhe; hongyu agreed after L52 exchange
- **Stance changes**: hongyu shifted from "Zoom necessary" → "Zoom at v1.1 acceptable"
- **Transcript refs**: L40-L62

### Topic 2: Weekly dogfood cadence
- **Outcome**: agreed — start Monday 2026-04-28
- **Decided by**: consensus
- **Stance changes**: none
- **Transcript refs**: L110-L120

## Topics raised but not resolved
- Pricing model for v3 (raised L150, deferred to next meeting)

## Topics in intents but not raised
- (none)

## Action items
- [ ] @daizhe — Discord bot prototype by 2026-04-28 (ref L62)
- [ ] @hongyu — write Whisper integration test by 2026-04-30 (ref L98)

## New facts surfaced
- Whisper API latency in CN-region: ~1.2s (advisor mentioned, L141)
```

Required sections (in order): `# <title>`, `## Topics covered`, `## Topics raised but not resolved`, `## Topics in intents but not raised`, `## Action items`, `## New facts surfaced`. Sections may be empty but headings MUST be present (so the parser can rely on them).

### 2.6 `knowledge-diff.md`

Written by `tmi wrap`. Each block is a proposed change to a file in the target repo. Full block format spec lives in §8 — schema reference here only.

### 2.7 `status.yaml`

Mutated by every command. Single source of truth for workflow state.

```yaml
schema_version: 1
state: live                              # see §9 for enum + transitions
state_updated_at: 2026-04-24T19:00:14+08:00
intents:                                 # one entry per participant
  daizhe: { ready: true, locked_at: 2026-04-24T18:35:00+08:00 }
  hongyu: { ready: true, locked_at: 2026-04-24T18:42:00+08:00 }
  advisor: { ready: false, locked_at: null }
bot:
  pid: 47823                             # null when not running
  started_at: 2026-04-24T19:00:10+08:00
  voice_channel_id: "1234567890"         # null when not connected
  reconnect_count: 0
observer:
  pid: 47845
  mode: observe                          # prep|observe|wrap|null
  last_poll_at: 2026-04-24T19:14:32+08:00
wrap:
  completed_at: null
  diff_block_count: null
review:
  approved_block_ids: []
  rejected_block_ids: []
  edited_block_ids: []
apply:
  target_repo: "C:/Users/daizhe zo/Desktop/Tangerine Intelligence"
  commit_sha: null
  applied_at: null
errors: []                               # list of {at, component, code, detail}
```

Concurrent-write rule: only ONE process at a time should hold the `.tmi/lock` file (PID-stamped). Writers MUST read-modify-write atomically by writing to `status.yaml.tmp` and renaming. [design-call: lock + atomic rename instead of fcntl, because Windows. Bot and CLI agree on the lock; observer never writes status.yaml directly — observer writes its outputs via stdout and CLI persists.]

---

## §3 Config Schema (`~/.tmi/config.yaml`)

Loaded by CLI on every invocation. Bot receives the path via `--config` flag and reads (read-only).

```yaml
schema_version: 1

meetings_repo: "C:/Users/daizhe zo/Desktop/tangerine-meetings"
# Required. Absolute path to git repo where meetings/ lives.
# Validation: must exist, must be a git repo, must be writable.

whisper:
  provider: openai                      # enum: openai|local. v1 only supports openai.
  api_key_env: OPENAI_API_KEY           # name of env var holding the key. Never store key in file.
  model: whisper-1                      # default: whisper-1
  chunk_seconds: 10                     # default: 10. Range: 5..30.
  language: null                        # ISO 639-1 or null for auto-detect

discord:
  bot_token_env: DISCORD_BOT_TOKEN      # env var name
  guild_id: "1199999999999999999"       # optional; if set, bot only responds in this guild
  command_prefix: tmi                   # slash command namespace prefix; default: "tmi"

claude:
  cli_path: null                        # null = auto-detect via PATH; else absolute path to `claude` binary
  subscription_check: true              # default: true; if true, `tmi init` verifies `claude --version` works
  default_timeout_seconds: 120          # observer subprocess wall-clock cap per turn

output_adapters:
  - type: claude_code                   # enum: claude_code (v1 only)
    name: tangerine-main                # unique within list; referenced by meeting.yaml.target_adapter
    target_repo: "C:/Users/daizhe zo/Desktop/Tangerine Intelligence"
    files:
      claude_md: "CLAUDE.md"            # path relative to target_repo
      knowledge_dir: "knowledge/"       # trailing slash required
      session_state: "knowledge/session-state.md"
    commit_author: "Tangerine Meeting Assistant <tma@tangerine.local>"
    auto_push: false                    # MUST be false in v1 (push is manual)

team:
  - alias: daizhe
    display_name: "Daizhe Zou"
    discord_id: "281234567890123456"
  - alias: hongyu
    display_name: "Hongyu Xu"
    discord_id: "291234567890123456"
  - alias: advisor
    display_name: "David Liu"
    discord_id: null                    # optional; not all team members are on Discord

logging:
  level: info                           # enum: debug|info|warn|error. Default: info.
  file: "~/.tmi/tmi.log"                # rotated at 10MB, keeps last 5
```

### Config validation

Performed on every CLI invocation. Validation errors print to stderr and exit code 2.

| Field | Validation |
|---|---|
| `meetings_repo` | exists, is dir, is git repo, writable |
| `whisper.provider` | must be `openai` in v1 |
| `whisper.api_key_env` | env var resolves to non-empty string when bot or wrap will run |
| `discord.bot_token_env` | env var resolves when bot will run |
| `claude.cli_path` | resolves to executable file |
| `output_adapters[].target_repo` | exists, is dir, is git repo |
| `output_adapters[].name` | unique within list |
| `team[].alias` | unique, matches `^[a-z][a-z0-9_]*$` |
| `team[].discord_id` | if present, matches `^\d{17,20}$` |

Env var resolution: `${ENV_VAR}` syntax is **not** used. Always specify the env var name in a `_env` field, never embed the value.

---

## §4 CLI Command Surface

All commands are subcommands of `tmi` (the Typer app). Run `tmi --help` for top-level usage.

Common conventions:
- Stdout: human-readable progress messages.
- Stderr: warnings + errors only.
- Exit codes: `0` success, `1` user error (bad args, validation), `2` config error, `3` external service failure (Whisper/Claude/Discord), `4` git conflict.
- `--meeting-id` can be omitted in `prep|start|observe|wrap|review|apply|status` if exactly one meeting is in a non-terminal state; the CLI infers it. Otherwise required.
- `--config <path>` global override; default `~/.tmi/config.yaml`.
- `--verbose`/`-v` raises log level to debug.

### 4.1 `tmi init`

```
tmi init [--meetings-repo <path>] [--force]
```
- Creates `~/.tmi/config.yaml` from template if absent (or refuses unless `--force`).
- Initializes `meetings_repo` (creates dir + `git init` if not a repo).
- Verifies `claude --version`, `node --version` if bot dir present.
- Side effects: writes `~/.tmi/config.yaml`, may run `git init`.
- Exit: 0 on success; 2 on missing prereqs.

### 4.2 `tmi new`

```
tmi new <title> [--participants alias1,alias2,...] [--scheduled <RFC3339>] [--target <adapter-name>]
```
- Generates `id = <YYYY-MM-DD>-<slugified-title>` (date = today in config TZ).
- Creates `meetings/<id>/` with `meeting.yaml`, empty `intents/`, empty `transcript.md`, empty `observations.md`, and `status.yaml` (state=`prepped` will be set after first prep; initial state is `created`).
- If `--participants` omitted, defaults to all `team[]` from config.
- If `--target` omitted and config has exactly one adapter, uses it; else errors.
- Stdout: prints absolute path of new meeting dir.
- Exit: 0; 1 if id collision (suggest `--suffix`).

[design-call: introduced `created` state because `prepped` per PLAN.md fires on first prep, but a meeting can exist with zero intents. `created` → `prepped` once the first intent locks. See §9.]

### 4.3 `tmi prep`

```
tmi prep [<meeting-id>] [--alias <alias>] [--turn-limit 20]
```
- Starts interactive observer subprocess in `prep` mode (see §6).
- `--alias` defaults to first team member whose intent is missing AND whose laptop hostname matches a future enhancement; for v1, prompts interactively if absent. [design-call: hostname auto-detect deferred; user supplies `--alias`.]
- On `done` from user OR `--turn-limit` reached, finalizes `intents/<alias>.md` with `locked: true`, commits to meetings repo with message `prep: <meeting-id> <alias>`.
- Updates `status.yaml.intents[<alias>] = {ready: true, locked_at: now}`.
- If this is the first ready intent, transitions state `created → prepped`.
- Stdout: streams the Claude session.
- Exit: 0; 1 if intent already locked (use `--force` to override); 3 if Claude subprocess fails.

### 4.4 `tmi start`

```
tmi start [<meeting-id>] [--no-bot] [--no-observer]
```
- Preconditions: state in `{prepped, created}`. If `created`, prints warning ("no intents locked, observer wrap quality will degrade") and continues unless `--strict`.
- Spawns Discord bot (unless `--no-bot`). See §5 for invocation.
- Spawns observer in `observe` mode (unless `--no-observer`). See §6.
- Updates state → `live`. Updates `status.yaml.bot.pid` and `status.yaml.observer.pid`.
- Acquires `.tmi/lock`.
- Returns immediately (subprocesses run detached). Stdout prints status banner + tail commands:
  ```
  Status: live · meeting=<id>
  Tail:   tail -f meetings/<id>/transcript.md
  Flags:  tail -f meetings/<id>/observations.md
  Stop:   tmi wrap <id>
  ```
- Exit: 0 on successful spawn; 3 if bot or observer fails to start.

### 4.5 `tmi observe`

```
tmi observe [<meeting-id>] [--mode silent|active]
```
- Same as `tmi start --no-bot`: spawns observer only. Used when transcript comes from elsewhere (e.g., manual paste, future Zoom adapter).
- Defaults `--mode silent` (file-only flags). `active` reserved for v1.1; in v1, `active` prints warning "active mode not implemented, using silent" and continues.
- Exit: same as `tmi start`.

### 4.6 `tmi wrap`

```
tmi wrap [<meeting-id>] [--auto] [--no-stop]
```
- Preconditions: state in `{live, ended}`.
- If state=`live` and not `--no-stop`: signals bot to leave voice channel + stop observer. State → `ended`.
- Spawns observer in `wrap` mode (one-shot). Inputs: all `intents/*.md`, full `transcript.md`, `observations.md`, target adapter's ground truth (loaded via `ClaudeCodeAdapter.read_ground_truth()`).
- Outputs `summary.md` and `knowledge-diff.md`.
- State → `wrapped` on success.
- Commits both files: `wrap: <meeting-id>`.
- `--auto` mode: invoked automatically by `/tmi-leave` from Discord (see §5); CLI is run by a sidecar process the bot spawns. [design-call: chose to keep auto-wrap as a CLI flag rather than embedding wrap logic in the bot; bot stays Discord-only.]
- Exit: 0; 3 if Claude wrap fails (state stays `ended`, partial `summary.md` may exist).

### 4.7 `tmi review`

```
tmi review [<meeting-id>]
```
- Preconditions: state = `wrapped`.
- Parses `knowledge-diff.md` into blocks (see §8). Presents each in turn:
  ```
  Block 3/7  ·  knowledge/session-state.md  ·  append
  Reason: Decision on v1 scope (Topic 1)
  Refs: L40, L52, L62
  ────────────────────────────────────────────
  + ### 2026-04-24 — David sync
  + - v1 scope 锁定为 Discord input + Claude Code output
  ────────────────────────────────────────────
  [a]pprove  [r]eject  [e]dit  [s]kip  [q]uit
  >
  ```
- `e`dit opens `$EDITOR` on the block; on save, parses again and treats as approved-with-edits.
- Persists choices to `status.yaml.review.{approved|rejected|edited}_block_ids`.
- State → `reviewed` once every block is decided (skip = leave for next time).
- Exit: 0; 1 if precondition not met.

### 4.8 `tmi apply`

```
tmi apply [<meeting-id>] [--no-commit]
```
- Preconditions: state = `reviewed`, at least one approved block.
- Calls `ClaudeCodeAdapter.apply_diff(...)` for the target adapter.
- On success, commits target repo with author from config, message `meeting: <title> (<date>)`.
- State → `merged`. Stores `apply.commit_sha`.
- **Never pushes.** Stdout reminds user: `cd <target_repo> && git push`.
- Exit: 0; 4 if git conflict (no commit made; see §10).

### 4.9 `tmi list`

```
tmi list [--status <state>] [--since <date>]
```
- Lists meetings in `meetings_repo`, one per line: `<id>  <state>  <title>`.
- Stdout only; exit 0.

### 4.10 `tmi status`

```
tmi status [<meeting-id>]
```
- Prints `status.yaml` content human-formatted, plus current participants/intents/transcript line count.
- Exit 0.

---

## §5 Discord Bot Protocol

Lives in `bot/`. Independent `package.json`. Built with `tsc` to `bot/dist/`. Entry: `bot/dist/index.js`.

### 5.1 Invocation

CLI starts the bot as a detached child process:

```bash
node bot/dist/index.js \
  --meeting-id 2026-04-24-david-sync \
  --meeting-dir "C:/.../meetings/2026-04-24-david-sync" \
  --config "C:/Users/.../.tmi/config.yaml"
```

Required flags:
- `--meeting-id` — for status updates and log tagging.
- `--meeting-dir` — absolute path; bot writes `transcript.md` and `status.yaml` here.
- `--config` — absolute path to `~/.tmi/config.yaml`. Bot reads (never writes) this file.

The bot inherits env: `DISCORD_BOT_TOKEN`, `OPENAI_API_KEY` from the CLI's environment.

Bot stdout/stderr are redirected to `<meeting-dir>/.tmi/bot.log`.

### 5.2 Slash commands the bot exposes

| Command | Args | Effect |
|---|---|---|
| `/tmi-join` | none | Bot joins the invoking user's current voice channel. Errors if user not in voice. |
| `/tmi-leave` | `auto_wrap?: bool = true` | Bot leaves voice channel. If `auto_wrap`, spawns sidecar `tmi wrap --auto <meeting-id>`. |
| `/tmi-status` | none | Replies with current `status.yaml.state` and active participant count. |

Slash command registration happens at bot startup, scoped to `discord.guild_id` if set, else global.

### 5.3 Per-user audio capture

For each user that speaks:
1. Bot subscribes to their Opus stream via `@discordjs/voice` `receiver.subscribe(userId, {end: AfterSilence(ms=800)})`.
2. Buffers Opus frames into 10-second chunks (`whisper.chunk_seconds`).
3. Decodes Opus → 16kHz mono WAV in-memory.
4. POSTs to OpenAI `/v1/audio/transcriptions` with `model=whisper-1`.
5. On response, looks up alias via `meeting.yaml.participants[].discord_id`. If unmapped, assigns next `GUEST:N`.
6. Appends one line to `transcript.md` (see §2.3 for format) using append + `fsync`.

Concurrent users → multiple parallel Whisper requests. No mutex on Whisper, only on the `transcript.md` write (mutex internal to bot process).

### 5.4 Bot's status updates

Bot writes to `status.yaml.bot.*` only. It MUST NOT touch other top-level keys. Implementation: read `status.yaml`, deep-merge `bot:` subtree, write to `status.yaml.tmp`, atomic rename.

Bot updates:
- `started_at`: on bot startup, before joining voice.
- `voice_channel_id`: on successful voice join; null on leave.
- `reconnect_count`: incremented on each reconnect attempt.
- `pid`: process.pid at startup; null on graceful exit.

[design-call: bot and observer share `status.yaml` but write disjoint subtrees. CLI writes top-level `state` and other subtrees. Cooperative discipline rather than per-subtree files because there's only ever one bot and one observer per meeting.]

### 5.5 Bot's responsibilities

- Voice channel join/leave
- Per-user audio capture
- Whisper streaming
- Transcript line writes
- `status.yaml.bot.*` updates
- Graceful shutdown on SIGTERM (CLI sends this on `tmi wrap --no-stop=false`)

### 5.6 Bot's NON-responsibilities (do not implement)

- Does NOT call Claude.
- Does NOT write `intents/*.md`, `summary.md`, `observations.md`, `knowledge-diff.md`.
- Does NOT mutate `meeting.yaml`.
- Does NOT mutate `status.yaml.state` (only writes `bot.*` subtree).
- Does NOT push git, does NOT commit.
- Does NOT format pretty messages for humans (Discord output is minimal, see §5.7).

### 5.7 Discord message format for status updates

In response to slash commands, bot replies with embed format:

```
{
  "title": "TMA · <meeting-id>",
  "fields": [
    {"name": "State", "value": "live", "inline": true},
    {"name": "Participants", "value": "daizhe, hongyu", "inline": true},
    {"name": "Transcript lines", "value": "247", "inline": true}
  ],
  "footer": {"text": "Tangerine Meeting Assistant v1"}
}
```

No pings, no public announcements. All bot replies are ephemeral (`flags: 64`) by default. [design-call: ephemeral default — no one wants 47 status messages cluttering #general.]

---

## §6 Observer (Claude Subprocess) Protocol

Three modes, three prompts. Prompts ship inside the Python package at `src/tmi/observer/prompts/`. Each prompt is a Markdown file the CLI passes via `--append-system-prompt`.

### 6.1 Common invocation pattern

```python
subprocess.Popen(
    [
        config.claude.cli_path or "claude",
        "--append-system-prompt", str(prompt_path),
        "--no-confirm",                # no interactive confirmations
        "--output-format", "stream-json",
    ],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=open(meeting_dir / ".tmi/observer.log", "ab"),
)
```

Prompts are absolute paths so working-directory changes don't break them.

### 6.2 Prep mode (`prompts/prep.md`)

- **Triggered by**: `tmi prep`.
- **Process model**: long-running interactive — CLI relays user stdin to subprocess stdin and prints subprocess stdout to user.
- **Inputs (sent on first turn via stdin as a single JSON envelope)**:
  ```json
  {
    "mode": "prep",
    "meeting": { /* contents of meeting.yaml */ },
    "alias": "daizhe",
    "ground_truth": {
      "claude_md": "...full text...",
      "session_state": "...full text...",
      "knowledge_files": [{"path": "knowledge/foo.md", "content": "..."}]
    }
  }
  ```
- **Output**: at session end (user types `done` or turn limit hit), the LAST stdout message MUST be a fenced JSON block:
  ````
  ```json
  {"intent_markdown": "---\nschema_version: 1\n...full intents/<alias>.md content..."}
  ```
  ````
  CLI captures this, validates against §2.2 schema, writes to `intents/<alias>.md`.
- **Failure modes**: see §10. If subprocess crashes mid-turn, CLI keeps the partial conversation log at `.tmi/observer.log` and lets user resume with `tmi prep --resume`.

### 6.3 Observe mode (`prompts/observe.md`)

- **Triggered by**: `tmi start` or `tmi observe`.
- **Process model**: long-running. CLI sends a poll envelope every 30 seconds.
- **Poll envelope**:
  ```json
  {
    "mode": "observe",
    "tick_at": "2026-04-24T19:14:00+08:00",
    "transcript_window": "...last 2 minutes of transcript.md...",
    "intents_summary": [{"alias": "daizhe", "topics": [...]}],
    "ground_truth_digest": "...",
    "previous_flags": [...last 3 flags from observations.md...]
  }
  ```
- **Output per tick**: a fenced JSON block:
  ````
  ```json
  {"flags": [
    {"type": "ground_truth_contradiction", "topic": "v1 scope",
     "transcript_ref": "L47-L52", "detail": "...", "severity": "medium"}
  ]}
  ```
  ````
  Empty flags array = silent tick (most ticks). CLI appends each flag to `observations.md` per §2.4 format.
- **Failure modes**: tick timeout → skip, log to `observer.log`. Three consecutive failures → mark `status.yaml.errors`, but observer keeps running.

### 6.4 Wrap mode (`prompts/wrap.md`)

- **Triggered by**: `tmi wrap`.
- **Process model**: one-shot.
- **Input envelope** (sent once on stdin, then stdin closed):
  ```json
  {
    "mode": "wrap",
    "meeting": { /* meeting.yaml */ },
    "intents": [{"alias": "daizhe", "markdown": "..."}, ...],
    "transcript": "...full transcript.md...",
    "observations": "...full observations.md...",
    "ground_truth": { /* same shape as prep */ },
    "adapter_conventions": {
      "claude_md_sections": ["核心规则", "公司信息", "法律红线", "部署铁律", ...],
      "session_state_format": "## YYYY-MM-DD — <title> blocks under '最近会议'",
      "knowledge_dir_pattern": "knowledge/<topic>.md"
    }
  }
  ```
- **Output**: TWO fenced JSON blocks, in order:
  ````
  ```json
  {"summary_markdown": "...full summary.md content..."}
  ```
  ```json
  {"diff_markdown": "...full knowledge-diff.md content..."}
  ```
  ````
  CLI validates both, writes them, commits.
- **Failure modes**: see §10. If only summary block is produced, write summary, leave state `ended`, exit 3.

### 6.5 Why JSON envelopes, not free text

The observer is a stochastic LLM. Strict JSON-block protocol means the CLI never has to "parse the model's prose." A regex finds the fenced ```json block, `json.loads` it, validate against Pydantic schema, persist. If the model produces malformed JSON, that's a failure mode (§10) with a clear retry rule.

---

## §7 Claude Code Output Adapter API

Pure Python module at `src/tmi/adapters/claude_code.py`. Importable from CLI; no I/O at import time.

### 7.1 Pydantic types

```python
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, Field
from datetime import datetime

class GroundTruth(BaseModel):
    claude_md: str                            # full file content
    session_state: str                        # full file content (may be "")
    knowledge_files: list["KnowledgeFile"]
    detected_at: datetime

class KnowledgeFile(BaseModel):
    path: str                                 # relative to target_repo, POSIX-style
    content: str

class Summary(BaseModel):
    markdown: str                             # full summary.md content
    meeting_id: str
    participants: list[str]

class Intent(BaseModel):
    alias: str
    markdown: str                             # full intent file content (incl. frontmatter)
    locked_at: datetime

class Transcript(BaseModel):
    text: str                                 # full transcript.md content
    line_count: int

class DiffBlock(BaseModel):
    id: int                                   # 1-based, monotonic
    target_file: str                          # relative to target_repo
    action: Literal["append", "replace", "insert", "create"]
    insert_anchor: str | None = None          # for insert: heading or line that precedes new content
    reason: str                               # one-line human reason
    transcript_refs: list[str]                # ["L47", "L52-L58"]
    body: str                                 # raw diff body (see §8)

class KnowledgeDiff(BaseModel):
    blocks: list[DiffBlock]
    generated_at: datetime
    meeting_id: str

class AppliedResult(BaseModel):
    written_files: list[str]                  # relative paths actually modified
    commit_sha: str | None                    # None if --no-commit
    skipped_block_ids: list[int]              # blocks that couldn't apply (logged in messages)
    messages: list[str]                       # human-readable log
```

### 7.2 Class signature

```python
class ClaudeCodeAdapter:
    def __init__(self, target_repo: Path, file_mappings: dict[str, str], commit_author: str):
        """file_mappings comes from config.output_adapters[].files."""

    def read_ground_truth(self) -> GroundTruth:
        """Load CLAUDE.md, session-state.md, and every *.md under knowledge_dir.
        Returns frozen snapshot (used by wrap mode as input)."""

    def parse_diff(self, diff_markdown: str) -> KnowledgeDiff:
        """Parse knowledge-diff.md into structured blocks. See §8 grammar.
        Raises ValueError with line number on malformed input."""

    def generate_diff(
        self,
        summary: Summary,
        intents: list[Intent],
        transcript: Transcript,
    ) -> KnowledgeDiff:
        """NOT used in v1 — wrap mode (the LLM) generates the diff text. This method
        exists for future direct-generation paths and is unimplemented in v1
        (raises NotImplementedError). [design-call: kept in API to avoid future
        breaking changes; wrap-LLM path is the only v1 producer.]"""

    def apply_diff(
        self,
        diff: KnowledgeDiff,
        approved_block_ids: list[int],
        edited_blocks: dict[int, DiffBlock] | None = None,
        commit: bool = True,
    ) -> AppliedResult:
        """For each approved block:
          - Resolve target_file path under target_repo
          - Apply action per §8 semantics
          - Stage the file
        After all blocks applied: optionally `git commit` with author from config.
        Refuses to write if target_repo has uncommitted changes touching any target_file
        (returns AppliedResult with skipped_block_ids populated and commit_sha=None)."""
```

### 7.3 Adapter behavior contract

- All paths joined under `target_repo` MUST be validated to stay within `target_repo` (no `../` escapes). Raise `ValueError` on attempt.
- `apply_diff` MUST be idempotent on no-op: applying an empty `approved_block_ids` returns `AppliedResult(written_files=[], commit_sha=None)`.
- Adapter NEVER reads or writes outside `target_repo`. Adapter NEVER reads `~/.tmi/config.yaml` (CLI passes the resolved `file_mappings` dict).
- Adapter NEVER pushes (`auto_push: false` is enforced by ignoring the field; v1 hard-codes no-push).

---

## §8 Diff Block Format

`knowledge-diff.md` is the heart of the product. Every block follows this exact grammar.

### 8.1 Grammar

```
diff-file := preamble? block (separator block)*
preamble  := "<!-- TMA knowledge-diff schema_version=1 meeting_id=<id> -->" newline+
separator := newline "---" newline
block     := id-line newline
             header-line newline
             metadata-block newline
             body-block

id-line       := "## Block " <integer> " · " <action> " · " <target-file>
header-line   := "**Reason**: " <reason>
metadata-block:= "**Transcript refs**: " <refs>
                 (newline "**Anchor**: " <anchor>)?
                 (newline "**Block-ID**: " <integer>)?
body-block    := fenced code block, language="diff" or "markdown" depending on action
```

### 8.2 Action semantics

| Action | Body language | Semantics |
|---|---|---|
| `append` | `diff` | Lines starting with `+ ` are appended at end of `target_file`. If file ends without trailing newline, one is added first. |
| `insert` | `diff` | `+ ` lines inserted immediately after `Anchor` (which must match a unique line in `target_file`). Errors if anchor missing or duplicated. |
| `replace` | `diff` | Standard unified diff (`+ `/`- ` lines). MUST include enough context (3 lines) for unambiguous match. Errors on conflict. |
| `create` | `markdown` | Body is the full new file content. Errors if `target_file` already exists (force flag may override in v1.1, not v1). |

### 8.3 Block ID semantics

- IDs are 1-based, monotonic within the file.
- The integer in `## Block 3 · ...` is the canonical ID and MUST equal the optional `**Block-ID**: 3` (redundant but explicit, used by `tmi review` for parsing robustness).
- IDs are stable: editing or rejecting a block does NOT renumber others.

### 8.4 Fully-formed example

````markdown
<!-- TMA knowledge-diff schema_version=1 meeting_id=2026-04-24-david-sync -->

## Block 1 · append · knowledge/session-state.md
**Reason**: Decision on v1 scope (David sync, 2026-04-24, Topic 1)
**Transcript refs**: L47, L52, L58
**Block-ID**: 1

```diff
+ ### 2026-04-24 — David sync
+ - v1 scope 锁定为 Discord input + Claude Code output（Zoom 延至 v1.1）
+ - 决策人: daizhe; hongyu 在 L52 后同意
+ - Action: @daizhe 4/28 前提交 Discord bot 原型
```

---

## Block 2 · insert · CLAUDE.md
**Reason**: Weekly TMA dogfood commitment from Topic 2
**Transcript refs**: L112
**Anchor**: ### 部署铁律 / Deployment Iron Rules
**Block-ID**: 2

```diff
+ ### 会议纪律
+ - 每周一 standup 必须走 TMA 流程（prep → start → wrap → review）
+ - Owner: @daizhe
```

---

## Block 3 · create · knowledge/whisper-latency.md
**Reason**: New fact surfaced by advisor (L141)
**Transcript refs**: L141
**Block-ID**: 3

```markdown
# Whisper API latency observations

- CN-region: ~1.2s per 10s chunk (advisor measurement, 2026-04-24)
- Acceptable for live transcript use case
- Re-test after OpenAI's CN endpoint rollout
```
````

### 8.5 Parsing rules

- Parser splits on `\n---\n` (with surrounding blank lines).
- Each block parsed independently; one malformed block does not invalidate others (errors are collected per-block).
- Unrecognized metadata keys are preserved in `DiffBlock.body` only if inside the fenced section; otherwise dropped with a warning.

---

## §9 Status State Machine

`status.yaml.state` is the workflow's source of truth. Legal values and transitions:

```
                ┌──────────┐
                │ created  │  ← `tmi new`
                └────┬─────┘
                     │ first intent locked
                     ▼
                ┌──────────┐
                │ prepped  │  ← `tmi prep` for any member
                └────┬─────┘
                     │ `tmi start`
                     ▼
                ┌──────────┐         bot disconnect 3x         ┌──────────────────┐
                │   live   │ ──────────────────────────────► │ failed_bot       │
                └────┬─────┘                                  └──────────────────┘
                     │ `tmi wrap` OR bot leaves voice
                     ▼
                ┌──────────┐
                │  ended   │
                └────┬─────┘
                     │ wrap completes
                     ▼
                ┌──────────┐         wrap parse fail            ┌──────────────────┐
                │ wrapped  │ ──────────────────────────────► │ failed_wrap      │
                └────┬─────┘                                  └──────────────────┘
                     │ `tmi review` finishes (every block decided)
                     ▼
                ┌──────────┐
                │ reviewed │
                └────┬─────┘
                     │ `tmi apply` succeeds
                     ▼                      git conflict        ┌──────────────────┐
                ┌──────────┐ ──────────────────────────────► │ failed_apply     │
                │  merged  │                                  └──────────────────┘
                └──────────┘
```

### 9.1 Enum values

`created | prepped | live | ended | wrapped | reviewed | merged | failed_bot | failed_observer | failed_wrap | failed_apply`

### 9.2 Transition triggers (authoritative)

| From | To | Trigger | Component |
|---|---|---|---|
| (none) | `created` | `tmi new` completes | CLI |
| `created` | `prepped` | First `intents/<alias>.md` locks | CLI (during `tmi prep` finalize) |
| `prepped` | `live` | `tmi start` spawns subprocesses successfully | CLI |
| `created` | `live` | `tmi start --strict=false` (with warning) | CLI |
| `live` | `ended` | `tmi wrap` (without `--no-stop`) OR `/tmi-leave` from Discord | CLI / Bot-triggered CLI |
| `live` | `failed_bot` | Bot reconnect_count >= 3 or unrecoverable | Bot writes errors[]; CLI sets state on next poll |
| `live` | `failed_observer` | Observer dies and can't restart | CLI |
| `ended` | `wrapped` | `tmi wrap` produces valid summary + diff | CLI |
| `ended` | `failed_wrap` | Wrap output malformed after retries | CLI |
| `wrapped` | `reviewed` | `tmi review` decides every block | CLI |
| `reviewed` | `merged` | `tmi apply` commits | CLI |
| `reviewed` | `failed_apply` | git conflict in target repo | CLI |
| `failed_*` | corresponding earlier state | `tmi <command> --retry` | CLI |

### 9.3 Forbidden transitions

Any transition not listed is forbidden. Implementations MUST refuse and exit code 1 with message `cannot transition <from> → <to>; use --retry or --force`.

`--force` exists ONLY on `tmi apply --force` for v1 (override "uncommitted changes in target" guard). Not added to other commands.

---

## §10 Failure Modes + Retry Semantics

### 10.1 Whisper API timeout / 5xx

- Bot retries up to 3x with exponential backoff (1s, 2s, 4s).
- After 3 failures: write line `[HH:MM:SS] [STT_FAILED]: chunk_id=<n> reason=<r> retries=3` to transcript.md.
- Continue capturing — one failed chunk does not stop the bot.
- Append `{at, component: "bot", code: "whisper_timeout", detail: "..."}` to `status.yaml.errors`.

### 10.2 Discord disconnect

- Bot listens for `voice.disconnect` events.
- Reconnects up to 3 times with backoff (5s, 15s, 30s).
- Each attempt: `status.yaml.bot.reconnect_count++`.
- After 3 failures: bot logs fatal, sets `status.yaml.bot.pid = null`, exits with code 1. CLI's poll loop notices, transitions state → `failed_bot`.

### 10.3 Observer subprocess crash

- Observe mode: CLI restarts up to 3 times.
- After 3 restarts in 5 minutes: state → `failed_observer`. Existing transcript and observations retained.
- Prep mode: no auto-restart (interactive); CLI prints recovery instruction (`tmi prep --resume`).
- Wrap mode: retries the whole one-shot up to 2 times. After: state → `failed_wrap`, partial `summary.md` may be present (atomic write — either both blocks land or neither). [design-call: atomic — better to have nothing than half a summary that looks complete.]

### 10.4 Wrap output malformed

- CLI parses the two JSON envelopes. On parse failure:
  - Retry once with stderr feedback ("previous output was malformed at line N: <reason>").
  - On second failure: state → `failed_wrap`, write raw output to `<meeting-dir>/.tmi/wrap-raw.txt` for debugging.

### 10.5 Apply git conflict

- Before writing any block, adapter runs `git status --porcelain` in target repo.
- If any target file appears in output: refuse to write, return `AppliedResult(commit_sha=None, skipped_block_ids=<all>, messages=["uncommitted changes in target_repo"])`.
- CLI sets state → `failed_apply`. User resolves manually, then `tmi apply --retry`.

### 10.6 Lock conflict

- If `<meeting-dir>/.tmi/lock` exists with a live PID, CLI refuses to start with exit 1.
- If lock exists but PID is dead, CLI cleans it up after warning and proceeds.

### 10.7 Schema version mismatch

- If a YAML file has `schema_version > 1`: CLI exits 2 with "newer TMA wrote this file; please upgrade".
- If `schema_version < 1`: CLI runs migration (no migrations exist in v1; placeholder for v1.1+).

---

## §11 Versioning + Compatibility

- Every YAML/Markdown-with-frontmatter file has a `schema_version: <int>` field.
- Current version: `1` for all schemas.
- Migration policy: a future TMA release MUST be able to read all older meeting dirs. Migration is one-way (older TMA refuses newer schema). Migrations live in `src/tmi/migrations/v<N>_to_v<N+1>.py`.
- Adapter type strings (`claude_code`, future `cursor`, `aider`) are stable identifiers; never renamed.

---

## §12 Testing Hooks

E2E tests live at `tests/e2e/`. Three integration boundaries are stubbed:

### 12.1 Discord bot stub

- Fixture: `tests/fixtures/discord_mock/`
- Mode: a Python helper that mimics the bot's filesystem outputs. Instead of running Node, the test:
  1. Writes a fixture `transcript.md` at controlled timestamps using a `FakeBot` helper.
  2. Updates `status.yaml.bot.*` per the bot's contract.
- Activation: `TMI_BOT_MODE=stub` env var. CLI's `tmi start` checks this and skips Node spawn, expecting the test's FakeBot to drive transcript writes.

### 12.2 Whisper stub

- Activation: `TMI_WHISPER_MODE=stub`.
- Bot (real Node) reads fixture audio chunks from `tests/fixtures/audio/*.opus` and a parallel `tests/fixtures/transcripts/<chunk-id>.txt` mapping. Returns the deterministic text instead of calling OpenAI.
- Whisper stub does NOT touch the network; tests work offline.

### 12.3 Claude subprocess stub

- Activation: `TMI_CLAUDE_MODE=stub`.
- CLI replaces `subprocess.Popen([claude, ...])` with `subprocess.Popen(["python", "tests/stubs/fake_claude.py", ...])`.
- `fake_claude.py` reads stdin envelope, switches on `mode`, returns canned JSON outputs from `tests/fixtures/claude/<mode>/<meeting-id>.json`.
- Stubs are exact — same JSON envelope contract as real observer.

### 12.4 Adapter stub

- For unit tests of the CLI without a real target repo, `ClaudeCodeAdapter` accepts an in-memory filesystem via constructor injection:
  ```python
  ClaudeCodeAdapter(target_repo=Path("/virtual"), file_mappings=..., commit_author=..., fs=InMemoryFS())
  ```
- `InMemoryFS` is a test-only class in `tests/helpers/`. Production code imports `pathlib.Path` directly and the `fs` parameter defaults to a real-disk implementation.

### 12.5 Standard E2E flow (test contract)

The canonical E2E test:
1. `tmi init --meetings-repo <tmpdir>` (real)
2. `tmi new "test sync" --participants daizhe,hongyu` (real)
3. `TMI_CLAUDE_MODE=stub tmi prep --alias daizhe` (stub)
4. `TMI_BOT_MODE=stub TMI_CLAUDE_MODE=stub tmi start` (stubs drive)
5. FakeBot writes 50 transcript lines over 10 simulated seconds
6. `tmi wrap` → stub returns canned summary + diff
7. `tmi review` runs in scripted mode (`--auto-approve-all`)
8. `tmi apply` → real git ops on a temp target repo
9. Assertions: target repo has expected commit, all states reached `merged`.

---

## §13 Memory Layer

The "memory layer" is a unified, repo-friendly view of every meeting and the
decisions that came out of it. It lives under the **target repo** (the same
repo `output_adapters[].target_repo` already points at), so the user's existing
git history doubles as their meeting archive.

The per-meeting `meetings/<id>/` directory under `meetings_repo` (§2.0) is the
**working set** — internal state for one meeting in flight. The memory layer is
the **published view** — flat files anyone (or any AI agent) can grep through
without understanding TMA's lifecycle.

### 13.1 Layout

```
<target_repo>/
└── memory/
    ├── meetings/
    │   └── 2026-04-25-david-roadmap-sync.md      # one flat file per meeting
    ├── decisions/
    │   └── postgres-over-mongo.md                # one file per extracted decision
    ├── people/                                   # v1.6+, not yet implemented
    ├── projects/                                 # v1.6+, not yet implemented
    ├── threads/                                  # v1.6+, not yet implemented
    └── glossary/                                 # v1.6+, not yet implemented
└── .tangerine/
    └── index.json                                # spec only, not yet written
```

For v1.5 only `meetings/` and `decisions/` are populated.

### 13.2 Memory root resolution

The Python CLI resolves the memory root via `Config.memory_root_path(adapter_name)`:

1. If `adapter_name` resolves to a configured `output_adapters[]` entry: use
   `<that adapter's target_repo>/memory`.
2. Else if exactly one adapter exists: use `<that adapter's target_repo>/memory`.
3. Else default to `~/.tangerine-memory/` (no `memory/` suffix — the home
   fallback IS the memory root).

The Discord bot's `resolveMemoryRoot(cfg)` mirrors this with two additional env
overrides for Tauri-spawned bot instances:

1. `MEMORY_ROOT` env var → used as-is (absolute path).
2. `TARGET_REPO` env var → `<TARGET_REPO>/memory`.
3. First `output_adapters[].target_repo` in the config → `<…>/memory`.
4. `<HOME>/.tangerine-memory`.

Both implementations MUST agree on resolution so the bot's live transcript
appends and the wrap-time rewrite land in the same file.

### 13.3 Meeting file format

`memory/meetings/<YYYY-MM-DD>-<slug>.md` where:
- `<YYYY-MM-DD>` = `meeting.created_at` date in `Asia/Shanghai` (+08:00).
- `<slug>` = `meeting.title` lowercased, alphanumerics only, hyphen-separated.

Slug rules (must match between Python `slugify_for_memory` and TS
`slugifyForMemory`):
- `s.strip().lower()`
- Replace runs of non-alphanumeric chars with `-`
- Collapse multiple hyphens
- Trim leading/trailing hyphens
- If empty, use `"untitled"`

Content:

```markdown
---
date: 2026-04-25
title: "David roadmap sync"
source: discord
meeting_id: 2026-04-25-david-roadmap-sync
participants:
  - daizhe
  - david
duration_min: 47        # null if can't be parsed from transcript timestamps
---

## Transcript

[19:00:00] daizhe: ...
[19:00:30] david: ...

## Summary

(optional — present after wrap)

## Decisions

(optional — present after wrap if any decisions extracted)
- [Use Postgres over Mongo](../decisions/use-postgres-over-mongo.md)
```

The bot writes a stub file (frontmatter + `## Transcript` heading) on first
voice activity, then appends each transcript line as it arrives. `tmi wrap`
re-renders the file at the end of the meeting with the full transcript +
summary body + decision links.

### 13.4 Decision file format

`memory/decisions/<slug>.md` where `<slug>` = lowercased decision-title slug
(same rules as §13.3).

```markdown
---
date: 2026-04-25
title: Use Postgres over Mongo
source: meeting
source_id: 2026-04-25-david-roadmap-sync
source_line: 47          # first transcript line ref; null if none
status: decided
---

## Decision

decided — Postgres for v1

**Decided by**: daizhe; david agreed at L52

## Context

<full topic block from summary.md>

## Provenance

- Source meeting: [David roadmap sync](../meetings/2026-04-25-david-roadmap-sync.md#L47)
- Transcript refs: L40, L52
```

The Provenance section is required and MUST point back to the source meeting
file. The `#L47` anchor relies on `react-markdown` rendering line numbers; no
explicit anchor tags are written to the transcript itself in v1.5.

### 13.5 Decision extraction

Performed by `tmi.memory.extract_decisions_from_summary()` in the `tmi wrap`
post-processing step. Heuristic:

1. Locate the `## Topics covered` section in `summary.md`.
2. For each `### Topic N: <title>` subsection:
   - Read the bullet `- **Outcome**: ...`. Skip topics with no Outcome.
   - If the Outcome value (lowercased) starts with `decided` or `agreed`,
     promote it to a decision.
3. Pull `Decided by`, `Transcript refs` from the same bullet block.
4. Use the topic title as the decision slug source.

Failures here are non-fatal — wrap still completes and writes summary +
knowledge-diff. The user gets a console warning if memory writes are skipped.

### 13.6 Backward compatibility

The per-meeting `meetings/<id>/` layout under `meetings_repo` (§2.0) is
unchanged. Old meetings remain valid. New meetings get both layouts: the
internal working set under `meetings_repo`, AND the published view under
`<target_repo>/memory`.

---

## Appendix A: File touch matrix

Quick reference — who writes what.

| File | tmi new | tmi prep | bot | observer (observe) | tmi wrap | tmi review | tmi apply |
|---|---|---|---|---|---|---|---|
| `meeting.yaml` | W | R | R | R | R | — | R |
| `intents/<alias>.md` | — | W | — | R | R | — | — |
| `transcript.md` | W (empty) | — | W (append) | R | R | — | — |
| `observations.md` | W (empty) | — | — | W (append) | R | — | — |
| `summary.md` | — | — | — | — | W | R | — |
| `knowledge-diff.md` | — | — | — | — | W | R/W (edits) | R |
| `status.yaml` | W | W (intents subtree) | W (bot subtree) | — (CLI writes for it) | W | W (review subtree) | W (apply subtree) |
| target repo files | — | — | — | — | — | — | W |
| `<target_repo>/memory/meetings/<slug>.md` | — | — | W (init + append) | — | W (rewrite full) | — | — |
| `<target_repo>/memory/decisions/<slug>.md` | — | — | — | — | W (one per decision) | — | — |

(R = reads, W = writes, — = neither.)

---

## Appendix B: Decisions log (`[design-call]` summary)

1. Closed enum on intent `Type` field — enables wrap-mode grouping.
2. Transcript lines in arrival order (not speech-start) — Whisper-native.
3. Observations as headings + `---` separators — diff-friendly.
4. `auto-wrap` is a CLI flag, not bot logic — bot stays Discord-only.
5. Hostname auto-detection for `--alias` deferred — interactive prompt for v1.
6. Atomic-or-nothing wrap output — no half-summaries.
7. Status file shared with disjoint subtrees — single status.yaml is simpler than 3 files.
8. `created` state added between (none) and `prepped` — meeting can exist before any intent.
9. Discord replies ephemeral by default — no channel noise.
10. `generate_diff()` reserved in adapter API but unimplemented in v1 — future-proofing without breaking changes.
11. Lock + atomic rename, not fcntl — Windows compatibility.
12. JSON envelopes for observer I/O — strict parse contract instead of prose.

---

**End of INTERFACES.md.** If you change a contract here, update §11 first (versioning), bump `schema_version` in any affected file, and notify the other two parallel agents.
