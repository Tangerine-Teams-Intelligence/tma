# API Surface Spec — Tauri Command Catalog

**Status:** v1.9 (current) + v2.0-alpha.1 (in-flight) + v2.5 / v3.5 (planned)
**Owner:** Tangerine core team
**Scope:** every Tauri-invokable command + every typed frontend wrapper
**Audience:** internal devs today; future Tangerine Builder SDK consumers tomorrow

---

## §0 Why unify

Right now when a dev asks "what's the API for X?", the honest answer is *grep `mod.rs`*. There is no single doc that lists every backend entry point alongside its frontend wrapper, its payload shape, and its phase of origin. Commands accreted in waves (v1.5 → v1.9 → v2.0-alpha) and live in 30+ Rust files, with their TS counterparts spread across `lib/tauri.ts` (the canonical typed wrapper layer) plus per-domain helpers in `lib/{ai-tools,canvas,ambient,...}.ts`. New hires can't onboard, sibling agents can't merge cleanly, and the future Builder SDK has no surface to point at.

This doc fixes that. It is the single source of truth for: command name (Rust + TS), payload + return shape, error contract, performance budget, version it landed in, and module owner. When Tangerine Builder ships, this catalog becomes the SDK's public API map — `npm install @tangerine/sdk` → every command here surfaces as a typed method.

---

## §1 Command organisation principles

The conventions below are non-negotiable for new commands. Existing v1.5–v1.7 commands (`run_tmi`, `tail_file`, etc.) predate them and stay grandfathered.

1. **One Rust module per domain.** Each `app/src-tauri/src/commands/{domain}.rs` owns one cohesive concern: `ai_tools`, `memory`, `canvas`, `co_thinker`, `writeback`, `notion`, `loom`, `zoom`, `telemetry`, `suppression`, etc. Cross-cutting helpers go in `crate::sources::*` or `crate::agi::*`, never inside another command module.
2. **One frontend wrapper per command** in `app/src/lib/tauri.ts`. Wrappers are typed (`Promise<T>`), call `safeInvoke()`, and ship a mock fallback for browser-dev / vitest. Commands never reach React components directly via raw `invoke()` — the wrapper is the contract.
3. **Naming.** Rust: `{domain}_{verb}` snake_case (`canvas_save_topic`, `notion_writeback_decision`). TS: `{domain}{Verb}` camelCase (`canvasSaveTopic`, `notionWritebackDecision`). Domain prefix is mandatory — `decision_*` and `lock_*` are banned because they collide across modules.
4. **Always `Result<T, AppError>` wrapped.** No Rust command may panic into the frontend. Every handler returns `Result<T, AppError>` or its `tauri::command` equivalent; mock fallbacks return a structurally-valid value (even if hollow) so the UI never crashes on a missing bridge.
5. **Phase markers** in `mod.rs` and `tauri.ts`. Each batch of commands sits between `// === Phase X-Y description ===` and `// === end Phase X-Y description ===`. This lets sibling agents merge in parallel without stomping each other.

---

## §2 Complete command catalogue

Grouped by domain. Rust path is relative to `app/src-tauri/src/commands/`.

### ai_tools — v1.8 P1

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `detect_ai_tools()` | `detectAITools<T>(mockFallback)` | `Vec<AIToolStatus>` | `ai_tools.rs` |
| `get_ai_tool_status(id)` | (read-through `detect_ai_tools`) | `AIToolStatus` | `ai_tools.rs` |

Sidebar status panel polls `detectAITools` every 60s. Returns Cursor / Claude Code / Ollama presence + reachability.

### memory + migration — v1.x + v2.0-alpha.1

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `resolve_memory_root()` | `resolveMemoryRoot()` | `MemoryRootInfo { path, exists, is_empty }` | `memory.rs` |
| `init_memory_with_samples()` | `initMemoryWithSamples()` | `InitMemoryResult { path, seeded, copied, error }` | `memory.rs` |
| `list_atoms({user?})` | (planned `listAtoms`) | `Vec<AtomEntry>` | `memory.rs` |

`list_atoms` is the v2.0-alpha.1 layered listing (team + personal scopes); the wrapper hasn't landed in `lib/tauri.ts` yet — `voiceNotesRecordAndTranscribe` is the first consumer of the personal scope.

### sources — Phase 2-A through 2-D

Ten capture sources, each with ~3 commands (config / validate / capture). Total ~30 commands.

| Source | Commands | File |
|---|---|---|
| **Discord** | `poll_discord_bot_presence`, `validate_discord_bot_token`, `validate_whisper_key` | `discord.rs` |
| **GitHub** | `github_device_flow_start`, `github_device_flow_poll`, `github_create_repo` | `github.rs` |
| **Notion** | `notion_get_config`, `notion_set_config`, `notion_validate_token`, `notion_list_databases`, `notion_capture`, `notion_writeback_decision` | `notion.rs` |
| **Loom** | `loom_get_config`, `loom_set_config`, `loom_validate_token`, `loom_pull_transcript`, `loom_capture` | `loom.rs` |
| **Zoom** | `zoom_get_config`, `zoom_set_config`, `zoom_validate_credentials`, `zoom_capture` | `zoom.rs` |
| **Email** | `email_test_connection`, `email_fetch_recent` | `crate::sources::email` |
| **Voice notes** | `voice_notes_record_and_transcribe`, `voice_notes_list_recent` | `crate::sources::voice_notes` |
| **Calendar / Slack** | (writeback only — see §writeback below) | `writeback_slack_calendar.rs` |
| **Linear** | (writeback only) | `crate::sources::linear` via `writeback.rs` |

TS wrappers live in `lib/tauri.ts` mirroring shapes 1:1: `NotionConfig`, `NotionDb`, `NotionAtom`, `LoomConfig`, `LoomAtom`, `ZoomConfig`, `ZoomMeetingAtom`, `EmailConfig`, `EmailFetchResult`, `VoiceAtom`, `VoiceListItem`. Per-source setup pages (`app/src/routes/sources/*`) are the canonical consumers.

### writeback — v1.8 P2

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `writeback_decision(path)` | `writebackDecision(path)` | `WritebackOutcome` (tagged union) | `writeback.rs` |
| `read_writeback_log({limit, source})` | `readWritebackLog({limit?, source?})` | `ReadWritebackLogResult { entries, log_path }` | `writeback.rs` |
| `set_writeback_watcher(enabled)` | `setWritebackWatcher(enabled)` | `{ running: bool }` | `writeback.rs` |
| `slack_writeback_brief(decisionPath, channelId)` | `slackWritebackBrief(...)` | `void` | `writeback_slack_calendar.rs` |
| `slack_writeback_summary(meetingPath, channelId)` | `slackWritebackSummary(...)` | `void` | `writeback_slack_calendar.rs` |
| `calendar_writeback_summary(meetingPath, eventId)` | `calendarWritebackSummary(...)` | `void` | `writeback_slack_calendar.rs` |
| `notion_writeback_decision({atom_path, db_id?})` | `notionWritebackDecision(...)` | `{ created, page_id?, idempotent_hit }` | `notion.rs` |

`WritebackOutcome` is the tagged-union template every writeback path follows: `posted` / `already_done` / `not_applicable` / `disabled` / `failed`. New writeback channels (Linear, Jira, etc.) MUST return this exact shape — the auto-watcher event payload depends on it.

### co_thinker — v1.9 P3

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `co_thinker_read_brain()` | `coThinkerReadBrain()` | `String` (markdown) | `co_thinker.rs` |
| `co_thinker_write_brain(content)` | `coThinkerWriteBrain(content)` | `void` | `co_thinker.rs` |
| `co_thinker_trigger_heartbeat(primary_tool_id?)` | `coThinkerTriggerHeartbeat(primaryToolId?)` | `HeartbeatOutcome` | `co_thinker.rs` |
| `co_thinker_status()` | `coThinkerStatus()` | `CoThinkerStatus` | `co_thinker.rs` |
| `co_thinker_dispatch({system_prompt, user_prompt, max_tokens?, temperature?}, primary_tool_id?)` | `coThinkerDispatch(req, primaryToolId?)` | `LlmResponse { text, channel_used, tool_id, latency_ms, tokens_estimate }` | `co_thinker_dispatch.rs` |

`co_thinker_dispatch` is the universal LLM entrypoint: routes to MCP-sampling / Ollama / browser-extension based on user-selected primary tool with priority-list fallback. Every other command that needs an LLM (ambient, sticky throws, suggestion engine) calls this — never raw HTTP.

### canvas + agi — v1.8 P4

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `canvas_list_projects()` | `canvasListProjects()` | `Vec<String>` | `canvas.rs` |
| `canvas_list_topics(project)` | `canvasListTopics(project)` | `Vec<String>` | `canvas.rs` |
| `canvas_load_topic(project, topic)` | `canvasLoadTopic(...)` | `String` (markdown) | `canvas.rs` |
| `canvas_save_topic(project, topic, content)` | `canvasSaveTopic(...)` | `void` | `canvas.rs` |
| `canvas_propose_lock(project, topic, sticky_id)` | `canvasProposeLock(...)` | `String` (decision atom path) | `canvas_agi.rs` |
| `agi_throw_sticky(project, topic, body, color)` | `agiThrowSticky(...)` | `String` (sticky id, 12 hex) | `canvas_agi.rs` |
| `agi_comment_sticky(project, topic, sticky_id, body)` | `agiCommentSticky(...)` | `void` | `canvas_agi.rs` |

On-disk shape is plain markdown with `canvas-meta` JSON frontmatter. AGI-thrown stickies are deliberately indistinguishable in shape from human-thrown ones — `shortUuid` matches between Rust and `lib/canvas.ts`.

### ambient + suggestions — v1.9

| Rust command | TS wrapper | Returns | File |
|---|---|---|---|
| `agi_analyze_input(text, surface_id, primary_tool_id?)` | `agiAnalyzeInput(...)` | `AmbientAnalyzeResult { text, confidence, channel_used, tool_id, latency_ms }` | `agi_ambient.rs` |
| `telemetry_log(event)` | `telemetryLog(event)` | `void` | `telemetry.rs` |
| `telemetry_read_window(hours)` | `telemetryReadWindow(hours)` | `Vec<TelemetryEventEnvelope>` | `telemetry.rs` |
| `telemetry_clear()` | `telemetryClear()` | `usize` (files removed) | `telemetry.rs` |
| `suppression_check(template, scope)` | `suppressionCheck(...)` | `bool` | `suppression.rs` |
| `suppression_list()` | `suppressionList()` | `Vec<SuppressionEntry>` | `suppression.rs` |
| `suppression_clear()` | `suppressionClear()` | `void` | `suppression.rs` |
| `suppression_recompute()` | `suppressionRecompute()` | `usize` (currently-suppressed count) | `suppression.rs` |

The ambient loop is tight: keystroke → debounce → `agi_analyze_input` → `co_thinker_dispatch` (under the hood) → AmbientAnalyzeResult → frontend's `shouldShowReaction` filter → maybe render. Sentinel `text === "(silent)"` is dropped without rendering.

### auth + paywall — planned v2.5

Not yet implemented. Reserved names:

| Rust command | TS wrapper | Returns |
|---|---|---|
| `auth_sign_in_email_password(email, password)` | `authSignInEmailPassword(...)` | `AuthSession { user_id, jwt, expires_at }` |
| `auth_sign_in_oauth(provider)` | `authSignInOAuth(provider)` | `AuthSession` |
| `auth_sign_out()` | `authSignOut()` | `void` |
| `billing_status()` | `billingStatus()` | `BillingStatus { tier, seat_count, renews_at }` |
| `billing_upgrade_to_paid()` | `billingUpgradeToPaid()` | `{ checkout_url }` |
| `billing_cancel()` | `billingCancel()` | `void` |

### marketplace — planned v3.5

| Rust command | TS wrapper | Returns |
|---|---|---|
| `marketplace_list_templates({filter})` | `marketplaceListTemplates(filter)` | `Vec<TemplateMatch>` |
| `marketplace_install_template(template_id)` | `marketplaceInstallTemplate(id)` | `{ installed_path }` |
| `marketplace_publish_template(metadata)` | `marketplacePublishTemplate(meta)` | `{ template_id, public_url }` |

### misc / grandfathered

`run_tmi`, `run_tmi_send_stdin`, `run_tmi_kill`, `start_bot`, `stop_bot`, `bot_status`, `list_meetings`, `read_meeting`, `read_meeting_file`, `tail_file`, `untail_file`, `watch_meeting`, `unwatch_meeting`, `get_config`, `set_config`, `get_secret`, `set_secret`, `write_env_file`, `open_external`, `open_in_editor`, `show_in_folder`, `system_notify`, `export_debug_bundle`, `check_updates`, `detect_claude_cli`, `detect_node_runtime`, `validate_target_repo`, `get_whisper_model_status`, `download_whisper_model`, `cancel_whisper_download`, `git_*` (7 commands), `sync_*` (4 commands), `generate_invite`, `parse_invite`, `get_ws_port`, `daemon_status`, `daemon_kick`, `read_timeline_today`, `read_timeline_recent`, `read_brief`, `read_alignment`, `read_pending_alerts`, `read_people_list`, `read_person`, `read_projects_list`, `read_project`, `read_threads_list`, `read_thread`, `mark_atom_viewed`, `mark_atom_acked`, `mark_user_opened`, `read_cursor`, `read_whats_new`. See `mod.rs:236-401` for the canonical handler registration.

---

## §3 Frontend type unification

`app/src/lib/tauri.ts` is the single source of truth for every TS shape that crosses the bridge.

- **`safeInvoke(cmd, args, mock)`** wraps `@tauri-apps/api/core::invoke`. Detects Tauri runtime via `"__TAURI_INTERNALS__" in window`; falls through to `mock()` outside Tauri so vitest + `vite dev` never crash. Failures inside Tauri log loudly via `console.error` before falling back, so engineers can grep for them in DevTools.
- **Phase-marked blocks.** Every batch sits between `// === Phase X-Y description ===` markers. Rule of thumb: if you're adding a new domain, add the marker first, then the type, then the wrapper. Sibling agents merging in parallel rely on this.
- **Type names mirror Rust.** `AIToolStatus` (Rust struct) → `AIToolStatus` (TS interface). `MemoryRootInfo`, `WritebackOutcome`, `CoThinkerStatus`, `HeartbeatOutcome`, `AmbientAnalyzeResult`, `SuppressionEntry`, `TelemetryEventEnvelope`, `LlmRequest`, `LlmResponse` — all 1:1. Tagged unions use TS discriminated unions on a `status` / `event` / `state` field.
- **No re-exports through middlemen.** Components never `import { canvasSaveTopic } from "lib/canvas"` when the wrapper lives in `lib/tauri.ts`. The domain helper files (`lib/canvas.ts`, `lib/ambient.ts`, `lib/sources.ts`) are for *post-bridge* logic only — round-trip helpers, throttling, sentinel filtering — never for hosting bridge wrappers.

---

## §4 Error handling

The Rust contract is defined by `crate::commands::error::AppError`:

```rust
enum AppError {
  User { code, detail },      // bad input from frontend (validation)
  Config { code, detail },    // user config / yaml / json malformed
  External { code, detail },  // upstream API failure (HTTP, third-party)
  Git { code, detail },       // git ops
  Internal { code, detail },  // panics, IO, anything we own
}
```

Serialised via `#[serde(tag = "kind", rename_all = "snake_case")]` so the frontend sees `{ kind: "external", code: "http", detail: "..." }`.

**Frontend handling:**
- TS catches at the wrapper boundary. `safeInvoke` already swallows + logs.
- For commands where the user must see the error (writeback, auth, billing), wrappers re-throw and the calling component runs `try { await ... } catch (e) { toast.error(errorMessage(e)) }`.
- **User-visible vs developer-only.** `User` + `Config` errors render as toasts with the `detail` string. `External` errors render with a friendly "Couldn't reach {service}" prefix and `code` for support tickets. `Internal` errors render as "Something broke" + a "Copy details" button — never expose the raw `detail` because it can leak paths.

---

## §5 Performance contract

These are p95 targets enforced by `tests/perf/*` (forthcoming). Commands consistently breaching their budget get refactored, not promoted.

| Command class | p95 budget | Examples |
|---|---|---|
| Read commands (filesystem, config) | < 50ms | `resolve_memory_root`, `list_meetings`, `canvas_load_topic`, `read_writeback_log`, `telemetry_read_window`, `suppression_list`, every `*_get_config` |
| Write commands (filesystem, atom) | < 200ms | `init_memory_with_samples`, `canvas_save_topic`, `co_thinker_write_brain`, `agi_throw_sticky`, `telemetry_log`, `set_secret` |
| LLM dispatch (one round trip) | < 5s | `co_thinker_dispatch`, `agi_analyze_input` |
| Heartbeat (ambient ingest + brain rewrite) | < 30s | `co_thinker_trigger_heartbeat`, daemon ticks |
| Capture (one source, lookback window) | < 10s | `notion_capture`, `loom_capture`, `zoom_capture`, `email_fetch_recent` |
| Validation (one upstream call) | < 3s | `*_validate_token`, `*_validate_credentials`, `email_test_connection`, `validate_whisper_key` |

LLM-bound commands (dispatch, ambient) own their own circuit breaker — if every channel is exhausted, `AppError::External { code: "all_channels_exhausted" }` returns within 5s rather than hanging.

---

## §6 Versioning + deprecation

- **Semver.** Adding a command is minor. Renaming or removing a command is major. Adding a non-optional argument to an existing command is major.
- **Deprecation flow.** Mark with `#[deprecated(note = "use foo_v2 instead")]` in Rust + a `@deprecated` JSDoc in TS. Log a one-line `tracing::warn!` on every call. Keep for one full minor release; remove on the next major.
- **v1.x → v2.x compat.** Every v1.x command stays callable through v2.x. Frontend code may migrate at its leisure. The v2.0-alpha.1 layered memory listing is additive — `list_atoms` lives alongside the existing single-scope reads.
- **Frontend shape stability.** TS interface fields may add optional properties freely. Removing or making a field non-optional is major. The `?` operator at the call site is the cheapest forward-compat lever — use it.

---

## §7 Future SDK extraction

When Tangerine Builder framework ships (target: post-v2.5):

- This catalogue becomes the public API map. `npm install @tangerine/sdk` exposes every command in §2 as a typed method on a `TangerineClient` class.
- Bridge layer is swappable. Today `safeInvoke` talks to Tauri's local IPC. Tomorrow it can talk to Tauri (desktop), HTTP (cloud-hosted Builder runtime), or in-process mock (test harness) behind the same wrapper signature.
- Auth becomes standardised. The `auth_*` family in §2 (planned v2.5) becomes the OAuth helper every Builder app inherits — no per-app implementation, just `client.auth.signInWithOAuth("google")`.
- Marketplace publishing flips from Tangerine-internal to Builder-public. `marketplace_publish_template` accepts third-party templates once the v3.5 review pipeline is up.

The contract is: anything in this doc that survives v2.5 is part of the SDK. If a command is provisional, it goes in the `// experimental` block in `lib/tauri.ts` and is omitted from the SDK export until it stabilises.

---

## §8 Out of scope

- **GraphQL / REST.** Tangerine OSS is Tauri-only. There is no HTTP server inside the desktop app (the localhost ws server at port 7780 is for the browser-extension bridge, not external consumers). Builder's hosted runtime will expose HTTP; that is a Builder concern, not OSS.
- **Public webhook endpoints.** Sources call out (Notion, Loom, Zoom REST APIs) but never expose inbound webhooks. If a source needs push notifications, the daemon polls — see `crate::daemon` for the heartbeat tick.
- **Telemetry export.** `telemetry_log` writes locally; there is no upload command and no plans for one. Cloud telemetry, if ever, ships as a separate opt-in MCP server.
- **Cross-machine sync of secrets.** Secrets are keychain-local; `set_secret` does not propagate. The team-sync layer (`sync_*` commands) syncs *memory atoms*, not credentials.

---

## §9 Risks (3)

1. **Type drift between Rust + TS.** Today the contract is hand-maintained — every Rust struct has a TS twin written manually. One side can drift silently (we've already shipped a `decisions_db_id` mismatch and caught it in code review, not at runtime). Mitigation candidate: codegen TS types from Rust serde via `ts-rs` or `specta`. Tradeoff: build-time complexity vs runtime safety.
2. **Performance regression as commands grow.** ~80 commands today; on track for 150+ by v2.5. Read commands that walk the memory dir (`list_atoms`, `read_timeline_*`, `canvas_list_*`) are the most fragile — a 10x growth in atom count can quietly turn a 50ms read into a 500ms read. Need a perf regression test in CI before v2.0 ships.
3. **Naming collision.** Domain prefix (`canvas_*`, `notion_*`) protects most cases, but as we add cross-domain commands (e.g. a future `decision_*` family that touches memory + writeback + canvas), the picking-the-right-prefix problem shows up. Risk: developer adds `decision_finalize` in `decisions.rs`, sibling agent adds the same name in `canvas_agi.rs`, registration breaks at compile time. Today the merge-conflict-on-`mod.rs` saves us; once we automate registration, we'll need a unique-name lint.

---

## §10 Open questions (3)

1. **Codegen TS types from Rust serde — does Tauri 2 have a first-class story?** Tauri 2's plugin system suggests `specta` is the recommended path (it ships derive macros for `Type`), but we haven't validated against our `#[serde(tag = "...")]` tagged unions yet. Spike before v2.5 to decide: codegen everything, codegen optional (most-touched types only), or stay manual.
2. **Versioning per-command vs all-or-nothing.** Today the whole IPC surface ships in lockstep with the desktop binary. Once the SDK exists, third-party apps may pin `@tangerine/sdk@2.4` while the user runs Tangerine Desktop v2.6. Do we version each command independently (granular but operationally heavy), or version the whole surface as one contract (simpler but coarser)? Decision needed before SDK extraction.
3. **SDK extraction timing — does Tangerine Builder ship before or after v2.5 paywall?** If Builder ships first, the SDK has to expose `auth_*` and `billing_*` before they're battle-tested in the desktop app. If paywall ships first, Builder is delayed to v3.x. Founder call. Default current plan: paywall (v2.5) → Builder (v3.0) → marketplace (v3.5).

---

*This doc updates whenever a new command lands in `mod.rs`. Diff-discipline: a PR that adds a Rust handler MUST add the matching row in §2 and the TS wrapper in `lib/tauri.ts` in the same commit.*
