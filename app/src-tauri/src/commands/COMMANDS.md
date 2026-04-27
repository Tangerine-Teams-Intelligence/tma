# Tauri Commands Inventory

**Generated:** Wave 3 cross-cut, 2026-04-26
**Source-of-truth:** [`API_SURFACE_SPEC.md`](../../../../API_SURFACE_SPEC.md) §2 catalog
**Cross-ref:** every Rust handler must appear in `tmi_invoke_handler!` ([`mod.rs`](mod.rs)) AND have a typed TS wrapper somewhere under [`app/src/lib/`](../../../../src/lib/) (canonically `tauri.ts`; domain helpers like `lib/git.ts` / `lib/views.ts` / `lib/daemon.ts` / `lib/branding.ts` / `lib/auth.ts` are tolerated for batched grandfathered domains).

This file is the **enforcement surface** for the spec's §1 conventions. CI / pre-commit can `diff` this against `mod.rs` and fail the build if they drift.

---

## §0 At-a-glance counts

| Metric | Value |
|---|---|
| `#[tauri::command]` markers (all `.rs` files under `src-tauri/src/`) | 185 |
| Commands registered in `tmi_invoke_handler!` | 191 |
| Commands with `safeInvoke` wrapper somewhere under `lib/` | 168 (after Wave 3 fill) |
| Commands with **no** TS wrapper (intentional / scheduled) | 6 |
| Commands violating `{domain}_{verb}` snake_case | 0 |
| Commands not returning `Result<T, AppError>` | 0 |

(Marker > registered when a `.rs` file declares a command but `mod.rs` hasn't wired it yet — those are work-in-progress and don't ship to the frontend.)

---

## §1 Command catalog (cross-referenced)

Each row below points at the §2 group in [`API_SURFACE_SPEC.md`](../../../../API_SURFACE_SPEC.md). When a command moves between modules (e.g. `email_*` migrates from `crate::sources::email` to a stable `commands::email` module), the catalog row in the spec must move with it — that's the enforcement contract.

### Process / runner / bot (grandfathered, §2.misc)

| Rust | TS wrapper | Status |
|---|---|---|
| `run_tmi` | (none — internal CLI bridge, called via `runTmiInteractive`) | grandfathered |
| `run_tmi_send_stdin` | (none) | grandfathered |
| `run_tmi_kill` | (none) | grandfathered |
| `start_bot` | `startBot(args)` | Wave 3 added |
| `stop_bot` | `stopBot(meetingId)` | Wave 3 added |
| `bot_status` | `botStatus(meetingId)` | Wave 3 added |

### Filesystem / meetings (grandfathered, §2.misc)

| Rust | TS wrapper | Status |
|---|---|---|
| `list_meetings` | `listMeetings()` | tauri.ts |
| `read_meeting` | `readMeeting(id)` | tauri.ts |
| `read_meeting_file` | `readMeetingFile(args)` | Wave 3 added |
| `tail_file` | `tailFile(path, onLine)` | tauri.ts (event-subscriber form) |
| `untail_file` | (via tailFile's unsubscribe handle) | tauri.ts |
| `watch_meeting` | `watchMeeting(meetingId)` | Wave 3 added |
| `unwatch_meeting` | `unwatchMeeting(watchId)` | Wave 3 added |

### Config / env / external (grandfathered, §2.misc)

| Rust | TS wrapper | Status |
|---|---|---|
| `get_config` | `getConfig()` | tauri.ts |
| `set_config` | `setConfig(cfg)` | tauri.ts |
| `get_secret` | `getSecret(key)` | tauri.ts |
| `set_secret` | `setSecret(key, val)` | tauri.ts |
| `write_env_file` | `writeEnvFile(entries)` | Wave 3 added |
| `open_external` | `openExternal(url)` | tauri.ts |
| `open_in_editor` | `openInEditor(path, line?)` | Wave 3 added |
| `show_in_folder` | `showInFolder(path)` | tauri.ts |
| `system_notify` | `systemNotify(title, body)` | tauri.ts |
| `export_debug_bundle` | `exportDebugBundle()` | tauri.ts |
| `check_updates` | `checkUpdates()` | Wave 3 added |
| `detect_claude_cli` | `detectClaudeCli()` | tauri.ts |
| `detect_node_runtime` | `detectNodeRuntime()` | tauri.ts |
| `validate_target_repo` | `validateTargetRepo(path)` | tauri.ts |
| `validate_whisper_key` | `validateWhisperKey(key)` | tauri.ts |
| `poll_discord_bot_presence` | `pollDiscordBotPresence(...)` | tauri.ts |
| `validate_discord_bot_token` | `validateDiscordBotToken(token)` | Wave 3 added |
| `get_whisper_model_status` | `getWhisperModelStatus()` | tauri.ts |
| `download_whisper_model` | `downloadWhisperModel(...)` | tauri.ts |
| `cancel_whisper_download` | `cancelWhisperDownload(id)` | tauri.ts |
| `get_ws_port` | `getWsPort()` | Wave 3 added |

### Memory layer (§2.memory)

| Rust | TS wrapper | Status |
|---|---|---|
| `resolve_memory_root` | `resolveMemoryRoot()` | tauri.ts |
| `init_memory_with_samples` | `initMemoryWithSamples()` | tauri.ts |
| `list_atoms` | `listAtoms()` | `lib/atoms.ts` (v2.0-alpha.2) |

### Sources — capture / config / validate (§2.sources)

`discord` / `github` / `notion` / `loom` / `zoom` / `email` / `voice_notes` / `linear` (writeback only). All wrappers in `tauri.ts` mirror the Rust struct names 1:1.

### Writeback (§2.writeback)

`writeback_decision`, `read_writeback_log`, `set_writeback_watcher`, plus `slack_writeback_brief`, `slack_writeback_summary`, `calendar_writeback_summary`, `notion_writeback_decision`. All wrapped in `tauri.ts`.

### Co-thinker / dispatch / ambient (§2.co_thinker, §2.ambient)

`co_thinker_read_brain`, `co_thinker_write_brain`, `co_thinker_trigger_heartbeat`, `co_thinker_status`, `co_thinker_dispatch`, `agi_analyze_input`. All wrapped in `tauri.ts`.

### Canvas + AGI peer (§2.canvas)

`canvas_list_projects`, `canvas_list_topics`, `canvas_load_topic`, `canvas_save_topic`, `canvas_propose_lock`, `agi_throw_sticky`, `agi_comment_sticky`. All wrapped in `lib/canvas.ts`.

### Telemetry / suppression (§2.ambient)

`telemetry_log`, `telemetry_read_window`, `telemetry_clear`, `suppression_check`, `suppression_recompute`, `suppression_clear`, `suppression_list`. Mostly in `lib/telemetry.ts` + `tauri.ts`.

### Active agents (§2.misc, v2.0-beta.2)

`get_active_agents` → `getActiveAgents()` in `tauri.ts`.

### v2.5 review / auth / billing / cloud_sync

| Rust | TS wrapper | Status |
|---|---|---|
| `review_create` / `review_cast_vote` / `review_get` / `review_list_open` / `review_promote` | `reviewCreate(...)` etc. | tauri.ts |
| `auth_sign_in_email_password` / `auth_sign_up` / `auth_sign_in_oauth` / `auth_verify_email` / `auth_sign_out` / `auth_session` | `authSignInEmailPassword(...)` etc. | tauri.ts |
| `billing_subscribe` / `billing_cancel` / `billing_status` / `billing_trial_start` / `billing_webhook` | `billing*(...)` | tauri.ts |
| `billing_reconcile` | `billingReconcile()` | Wave 3 added |
| `email_verify_send` / `email_verify_confirm` / `email_verify_status` | `emailVerifySend(...)` etc. | Wave 3 added |
| `cloud_sync_get_config` / `cloud_sync_set_config` / `cloud_sync_init` / `cloud_sync_pull` / `cloud_sync_push` | `cloudSync*(...)` | tauri.ts |

### v3.0 personal agents

12 commands — `personal_agents_scan_all`, 8 `personal_agents_capture_*`, `personal_agents_get_settings`, `personal_agents_set_settings`, `personal_agents_set_watcher`, plus 2 webhook hooks. All wrapped in `tauri.ts`.

### v3.5 marketplace / branding / sso / audit

| Rust | TS wrapper | Status |
|---|---|---|
| `marketplace_list_templates` / `_install_template` / `_is_installed` / `_uninstall_template` / `_publish_template` / `_get_launch_state` | `marketplace*(...)` | tauri.ts |
| `branding_get_config` / `_apply` / `_reset_to_default` / `_validate_license` | `branding*(...)` | `lib/branding.ts` |
| `sso_set_config` / `_get_config` / `_list_configs` / `_validate_saml_response` / `_validate_saml_response_with_result` | `sso*(...)` | tauri.ts (with-result added Wave 3) |
| `audit_append` / `_read_window` / `_read_day` / `_search` / `_log_export` / `_verify_chain` / `_get_region` / `_set_region` | `audit*(...)` | tauri.ts (full set Wave 3) |

### v3.0 external world (RSS / podcast / YouTube / article)

10 commands under `external_*`. All wrapped via `safeInvoke` in `tauri.ts`.

### Git / sync / GitHub / invite / views

Heavy grandfathered batch (29 commands). All wrappers live in domain helpers (`lib/git.ts`, `lib/github.ts`, `lib/views.ts`, `lib/daemon.ts`) per §3 of the spec — those modules predate the `tauri.ts`-canonical rule.

---

## §2 Naming-violation audit

A scan over `tmi_invoke_handler!` for camelCase or missing-domain-prefix returns **0 violations**. Every registered command is `{domain}_{verb}` snake_case; every TS wrapper is `{domain}{Verb}` camelCase. Grandfathered single-segment names (`tail_file`, `start_bot`, etc.) are tolerated per §1.misc.

## §3 Result wrapping audit

Every `#[tauri::command]` in `commands/*.rs` (excluding `mod.rs`, `error.rs`, `paths.rs`, `runner.rs`) returns `Result<T, AppError>` (or `Result<T, super::AppError>` via re-export). **0 commands return raw values into the frontend.**

## §4 Performance budgets

Per [`API_SURFACE_SPEC.md`](../../../../API_SURFACE_SPEC.md) §5. Each command file's module docstring carries the relevant budget bucket as a one-line `//! Perf:` annotation (added Wave 3). The `tests/perf/` harness is forthcoming — track regressions until then via `tracing::info!(latency_ms = ?)` baked into hot commands.

| Bucket | p95 budget | Examples |
|---|---|---|
| Read (fs/config) | 50 ms | `resolve_memory_root`, `canvas_load_topic`, `read_writeback_log`, `audit_read_window` |
| Write (fs/atom) | 200 ms | `init_memory_with_samples`, `canvas_save_topic`, `co_thinker_write_brain`, `telemetry_log` |
| LLM dispatch | 5 s | `co_thinker_dispatch`, `agi_analyze_input` |
| Heartbeat | 30 s | `co_thinker_trigger_heartbeat`, daemon ticks |
| Capture | 10 s | `notion_capture`, `loom_capture`, `zoom_capture`, `email_fetch_recent` |
| Validation | 3 s | `*_validate_token`, `email_test_connection`, `validate_whisper_key` |

## §5 Drift checks (CI hooks, planned)

1. `mod.rs` `tmi_invoke_handler!` ↔ `#[tauri::command]` markers must match.
2. Every `tmi_invoke_handler!` entry must have either (a) a `safeInvoke("<cmd>", ...)` reference somewhere under `app/src/lib/`, or (b) be listed in §6 below as intentionally-no-wrapper.
3. `API_SURFACE_SPEC.md` §2 catalog row count must equal `tmi_invoke_handler!` count.

## §6 Intentionally no TS wrapper

Some commands are **only** called from the daemon or from another Rust thread; they're registered (so the IPC surface is stable) but no React surface needs them today.

| Command | Reason |
|---|---|
| `run_tmi` / `run_tmi_send_stdin` / `run_tmi_kill` | Internal CLI bridge; React calls `runTmiInteractive` higher-level wrapper instead. |
| `untail_file` | Exposed via `tailFile`'s returned unsubscribe handle. |
| (all others) | All have wrappers as of Wave 3. |

---

## §7 Codegen plan (deferred)

Tauri 2 has no first-class serde-to-TS codegen baked in (Specta is the recommended ecosystem path; not adopted yet to avoid build-time complexity per spec §9 risk #1). Until then:

- Type drift is caught in code review.
- `tauri.ts` types use the same field names as the Rust structs (`written` not `atomsWritten`, `last_active` not `lastActive`) so JSON round-trips are exact.
- A future spike (post-v2.5) may adopt `specta` for the most-touched types only.

---

*Update this file whenever a command is added / renamed / removed. CI will eventually fail on drift.*
