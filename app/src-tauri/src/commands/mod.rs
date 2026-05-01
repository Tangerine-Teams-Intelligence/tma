//! T3 — IPC command surface for Tangerine AI Teams v1.5.
//!
//! All Tauri-invokable commands live in submodules of this file; the
//! [`register`] helper attaches them to a partially-built `tauri::Builder`
//! returned by T1's `main.rs`. T1 should call:
//!
//! ```ignore
//! mod commands;
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_shell::init())
//!     // ...other plugins T1 owns...
//!     .setup(commands::setup_state)
//!     .invoke_handler(commands::handlers())
//!     .run(tauri::generate_context!())
//!     .expect("error while running tauri application");
//! ```
//!
//! That keeps T1's main.rs in charge of plugin order and window config while
//! T3 owns command registration in one place.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
// === v1.14.1 round-2 ===
use std::time::SystemTime;
// === end v1.14.1 round-2 ===

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

pub mod config;
pub mod daemon;
pub mod meetings;
pub mod memory;
pub mod tmi;
pub mod bot;
pub mod fs;
pub mod discord;
pub mod env;
pub mod external;
pub mod update;
pub mod whisper_model;
pub mod ai_tools;

// === v1.16 — co_thinker_dispatch removed ===
// The Tauri wrapper around `agi::session_borrower::dispatch` is gone.
// React callers that used `co_thinker_dispatch` will hit "command not
// found" and must be reworked by W1A3 / W2.
// === end v1.16 ===

// === Phase 2-B writeback (Slack + Calendar) ===
// v1.8 Phase 2: writeback to Slack (pre-meeting brief + decision summary)
// and Google Calendar (append summary to event description). Sibling agents
// own GitHub / Linear writeback in `writeback.rs` — the two modules are
// independent and may merge separately.
pub mod writeback_slack_calendar;
// === end Phase 2-B writeback ===

// === Phase 2-A writeback (GitHub + Linear) ===
// v1.8 Phase 2: closes the loop on the GitHub + Linear capture connectors
// by posting a markdown comment back to the linked PR (GitHub) or opening
// a "decision recorded" issue in the linked project (Linear) when an
// atom-decision is finalised under `~/.tangerine-memory/decisions/`. The
// adapters live in `crate::sources::{github, linear}`; this module is the
// thin Tauri command surface so the frontend can manually trigger and read
// the writeback log. The filesystem watcher in `crate::sources::watcher`
// is opt-in (toggled per-source in ~/.tmi/config.yaml).
pub mod writeback;
// === end Phase 2-A writeback ===

// Stage 1 Wave 3 — view-layer commands (today / people / projects / threads
// / alignment / inbox / cursor writes / what's-new diff). Pure read/write
// over the .tangerine/ sidecar; no shared state.
pub mod views;

// === v1.17.1 ===
// TEAM_INDEX.md auto-write — bridges captured atoms to NEW AI sessions.
// Any AI tool that reads the user's project CLAUDE.md (or Cursor rules /
// etc.) auto-loads the team's recent memory via
// `@~/.tangerine-memory/TEAM_INDEX.md`. Composer is pure
// (`build_team_index_markdown`); driver hits the same memory root +
// timeline.json that views.rs already owns. The daemon heartbeat calls
// `write_team_index_to` after each successful index-rebuild so the file
// refreshes on every ingestion.
pub mod team_index;
// === end v1.17.1 ===

// v1.6.0 team memory sync.
pub mod git;
pub mod github;
pub mod sync;
pub mod invite;
pub mod ws;

// === wave 10 ===
// v1.10 — auto-sync layer over the user's `~/.tangerine-memory/` git repo.
// Glues the heartbeat into a `git add -A && git commit -m ...` and exposes
// pull/push/status/init/history Tauri commands consumed by the new
// GitSyncIndicator + GitInitBanner React components. Sits next to the
// existing `git` module — that one is the team-mode wizard's OAuth-token
// surface; this one is the always-on auto-sync the daemon drives.
pub mod git_sync;
// === end wave 10 ===

// === Phase 2-C real-wire (Notion + Loom + Zoom) ===
// v1.8 Phase 2: read-side connectors that walk Notion databases, Loom
// workspace videos, and Zoom cloud recordings, and write atoms into the
// user's memory dir. Notion also has a writeback path for decisions.
// Each module owns its own per-user JSON config under
// `<user_data>/sources/{name}.json` and reads its bearer secret(s) from
// the shared `.env` allow-list (see env.rs). Daemon ticks them per
// heartbeat — skipped when no token is configured.
pub mod notion;
pub mod loom;
pub mod zoom;
// === end Phase 2-C real-wire ===

// === v1.16 — co_thinker engine removed ===
// The /co-thinker route + brain.md surface depended on the LLM dispatcher.
// React callers that used `co_thinker_*` commands will hit "command not
// found" until W1A3 ships the static-display replacement.
// === end v1.16 ===

// === Phase 4-B canvas surface ===
// v1.8 Phase 4-B: per-project ideation surface (sticky notes + threading).
// React side at `app/src/routes/canvas.tsx` + `app/src/components/canvas/*`;
// the inert filesystem layer at `crate::agi::canvas`. Sibling P4-C agent
// wires AGI peer behaviors (the AGI participates as a peer, posting stickies
// and replies) on top of the same on-disk file shape — that lives in P4-C's
// own module and is independent of this command surface.
pub mod canvas;
// === end Phase 4-B canvas surface ===

// === v1.16 — ambient input layer removed ===
// `agi_analyze_input` was the once-per-debounced-edit hook into the
// borrowed-LLM dispatcher. With the LLM stack gone, the React observer
// is dead too (W1A3 prunes the listener). React calls hit "command not
// found".
// === end v1.16 ===

// === Phase 4-C agi peer + propose lock ===
// v1.8 Phase 4-C: AGI participates on Canvas surfaces as a peer, and the
// "propose as decision" affordance lifts a sticky into a draft decision
// atom under `~/.tangerine-memory/decisions/`. This module is the thin
// Tauri command surface; the engine lives in `crate::agi::propose_lock` +
// `crate::agi::canvas_writer`. Heartbeat-driven sticky throws are wired
// in `crate::agi::co_thinker`'s sentinel parser (THROW_STICKY: /
// COMMENT_STICKY:) — these commands are the manual entry point used by
// the AgiStickyAffordances button + dogfood tests.
pub mod canvas_agi;
// === end Phase 4-C agi peer + propose lock ===

// === v1.9 P1-A telemetry ===
// v1.9.0-beta.1: action telemetry foundation. The frontend's `logEvent`
// wrapper calls `telemetry_log` from every meaningful UI surface
// (navigate_route, dismiss_chip, edit_atom, ...). Storage is append-only
// JSONL under `~/.tangerine-memory/.tangerine/telemetry/{date}.jsonl`. The
// engine that consumes this telemetry to fire rule-based suggestion
// templates lands in v1.9.0-beta.2 — this slice is just the writer.
pub mod telemetry;
// === end v1.9 P1-A telemetry ===

// === v1.9 P3-A suppression ===
// v1.9.0-beta.3: dismiss × 3 → 30d suppression. The frontend
// `pushSuggestion` calls `suppression_check` before dispatching to drop
// matches whose `{template, scope}` pair has been dismissed 3+ times in
// the last 30 days. Storage at
// `~/.tangerine-memory/.tangerine/suppression.json`; the daemon
// recomputes the map on every heartbeat from the telemetry jsonl. The
// AGI Settings page consumes `suppression_list` + `suppression_clear`
// to give the user visibility + an escape hatch.
pub mod suppression;
// === end v1.9 P3-A suppression ===

// === v2.0-beta.2 active agents ===
// v2.0-beta.2: ACTIVE AGENTS sidebar feed. The React-side polling client
// (`app/src/components/layout/ActiveAgentsSection.tsx`) calls
// `get_active_agents` every 10s when the sidebar route is active, every 60s
// otherwise. v2.0-beta.2 ships stub data — the real per-source capture
// orchestrator (Cursor / Claude Code / Devin / Replit / Apple Intelligence)
// lands in v3.0 alongside the personal vault. See V2_0_SPEC.md §3.1 / §3.2.
pub mod active_agents;
// === end v2.0-beta.2 active agents ===

// === v2.5 review ===
// v2.5 §1 — Decision review (PR-style). Co-thinker proposes a decision;
// teammates vote on `/reviews`; 2/3 quorum auto-promotes (atom status →
// `locked`). Storage is a `*.review.json` sidecar next to each decision
// atom under `team/decisions/`. Engine in `crate::agi::review`.
pub mod review;
// === end v2.5 review ===

// === wave 1.13-B ===
// L4/L5 — Frontmatter-native review workflow + inline comment threads.
// Sits beside the v2.5 sidecar review surface above; the new layer is
// what the /reviews tabs + MemoryPreview comment sidebar call. Coordinates
// with Wave 1.13-A's `inbox_emit` for review_request + comment-mention
// notifications via the `commands::inbox` stub (1.13-A flips that stub to
// its real impl when it lands). Engine in `crate::agi::review_workflow`.
pub mod inbox;
pub mod comments;
// === end wave 1.13-B ===

// === v2.5 auth + billing ===
// v2.5 §2 + §3 — Tauri command surface for real Supabase auth + Stripe
// Connect billing. Both modules thin-wrap `crate::auth` + `crate::billing`
// and ship in stub mode by default. Sibling React surfaces (`/billing` route,
// TrialBanner, paywall gate) call these commands today; the swap to real
// mode is gated on env vars (`STRIPE_API_KEY`, `SUPABASE_URL`) — no code
// change required.
pub mod auth;
pub mod billing;
// === end v2.5 auth + billing ===

// === v3.0 personal agents ===
// v3.0 §1 — Tauri command surface for personal AI agent capture (Cursor /
// Claude Code / Codex / Windsurf). Wraps the read-side adapters in
// `crate::personal_agents` and persists the per-source enable flags under
// `<user_data>/personal_agents.json`. Strict opt-in; default off.
pub mod personal_agents;
// === end v3.0 personal agents ===

// === v3.5 marketplace ===
// v3.5 §1 — marketplace backend Tauri commands. Stub mode by default; the
// React `/marketplace` route reads `marketplace_get_launch_state` to decide
// whether to render the "Coming live when CEO triggers launch gate" banner.
pub mod marketplace;
// === end v3.5 marketplace ===

// === v3.5 branding ===
// v3.5 §4 — enterprise white-label Tauri commands. Default config = Tangerine
// baseline; tenants overlay logo / palette / domain / app name. License
// validator is a stub that accepts `tangerine-trial-*` / `tangerine-license-*`.
pub mod branding;
// === end v3.5 branding ===

// === v3.5 sso ===
// v3.5 §5.1 — SSO SAML Tauri commands. Stub `validate_saml_response` returns a
// deterministic mock assertion so React JIT-provisioning UI can demo the flow.
// Production wires `keycloak-rs` / WorkOS via single-file swap inside the lib.
pub mod sso;
// === end v3.5 sso ===

// === v3.5 audit ===
// v3.5 §5.2 — enterprise audit log Tauri commands. Append-only JSONL per UTC
// day. Stub mode stamps `region = "us-east"`; real region routing in
// enterprise tier (per spec §4.2 / §5.3).
pub mod audit;
// === end v3.5 audit ===

// === wave 11 ===
// v1.10.2 — first-run LLM channel setup wizard. 5 commands behind the
// React `SetupWizard.tsx`: detect installed editors / Ollama / browsers,
// auto-merge a `tangerine` entry into the chosen editor's mcp.json, send a
// canonical test prompt through `session_borrower::dispatch`, surface OS-
// specific Ollama install hints, and persist a "channel ready" state file
// so the wizard banner self-hides for users who already finished. See
// `setup_wizard.rs` for the full doc comment + command shapes.
pub mod setup_wizard;
// === end wave 11 ===

// === wave 13 ===
// v1.10.3 — populated-app first-launch demo seed. New surface that does
// NOT overlap with `commands::memory::init_memory_with_samples` (that
// older flat-layout seeder still ships its 3-file v1.x seed). Wave 13's
// `demo_seed` writes the richer layered tree (`team/co-thinker.md` +
// `team/decisions/<date>-<slug>.md` + `team/timeline/<date>.md` +
// `personal/<user>/threads/<vendor>/...` + `agi/observations/<date>.md`)
// and exposes a clear path so the user can wipe just the seeded files
// once they replace them with real team content. See `demo_seed.rs`.
pub mod demo_seed;
// === end wave 13 ===

// === wave 15 ===
// v1.10.4 — Cmd+K full memory search. Walks the user's
// `~/.tangerine-memory/` tree and returns scored AtomSearchResult rows
// the React `CommandPalette` renders inline below ACTIONS / NAVIGATE.
// Sits next to (NOT replacing) `crate::memory_search`: that one is the
// browser-extension MCP wire shape (absolute paths, ~200 char snippets
// for an LLM prompt); this one is the palette-friendly shape
// (rel paths, ~150 char snippets, vendor / author / timestamp from
// frontmatter for a colour-dot UI). See `search.rs`.
pub mod search;
// === end wave 15 ===

// === wave 16 ===
// Wave 16 — activity event bus Tauri command surface. One command,
// `activity_recent`, that reads from the in-memory ring buffer in
// `crate::activity`. The atom-write side fires `activity:atom_written`
// events on every successful write (see `crate::activity::record_atom_written`
// — call sites in `personal_agents::*` parsers, daily_notes saves, etc.;
// the v1.8 co_thinker call site was removed in v1.16 along with the engine).
pub mod activity;
// === end wave 16 ===

// === wave 18 — v1.16 stub ===
// The conversational onboarding agent (LLM-driven setup intent parser)
// was killed in v1.16. The Tauri command name stays registered but every
// call returns `removed_in_v1_16`. React side falls back to the
// form-based setup wizard (Cmd+K → "Use form-based setup"); W1A3 prunes
// the chat UI separately.
pub mod onboarding_chat;
// === end wave 18 ===

// === wave 24 ===
// v1.11 — Daily notes infrastructure + template library. Idempotent
// "today's daily note" creation under `team/daily/{YYYY-MM-DD}.md` plus a
// bundled template library (`app/resources/sample-memory/templates/`)
// the user can apply to any new atom. The co-thinker heartbeat calls
// `daily_notes::ensure_today_path_for` + `update_auto_section` to fill
// the auto sections with the last-24h atom summary. See `daily_notes.rs`
// for the full module doc.
pub mod daily_notes;
// === end wave 24 ===

// === wave 1.13-E ===
// v1.13 Agent E — OS-keychain-backed source token store + privacy panel
// support. Distinct from `commands::env` (the .env-file allow-list) and
// from `commands::sync::TokenStore` (the GitHub-specific keychain). This
// module is the generic surface for OAuth tokens belonging to the
// v1.13-E human-comm sources (Lark / Zoom / Teams / Slack / GitHub).
// Tokens are namespaced under `tangerine.source.<source>.<account>` and
// never leave the OS keychain — the Privacy panel renders presence-only.
pub mod secret_store;
pub mod privacy;
// === end wave 1.13-E ===

// === wave 1.13-D ===
// v1.13 — git-mediated team presence. Two commands wrap
// `crate::agi::presence`: `presence_emit` (writes the local user's
// presence file every 10 s; called from the React `PresenceProvider`)
// and `presence_list_active` (returns teammates fresher than a TTL;
// drives the avatar dots + top-bar pill + atom-preview indicator).
pub mod presence;
// === end wave 1.13-D ===

// === wave 1.13-A ===
// Wave 1.13-A — Identity + canonical Inbox store for the collab MVP.
//   * `identity` surfaces the current user (alias + optional display name +
//     email + avatar URL) and the team roster (derived from
//     `<memory_dir>/personal/*` subdirectories — each subdir name == one
//     teammate's alias).
//   * `inbox_store` is the canonical append-only JSONL the @mention parser
//     fires into; the new /inbox React route consumes it via
//     `inbox_list` / `inbox_emit` / `inbox_mark_read` / `inbox_archive` /
//     `inbox_mark_all_read`.
//
// Coexists deliberately with the Wave 1.13-B placeholder at
// `commands::inbox` (different schema + dated-shard storage; left untouched
// per the agent-A-doesn't-touch-other-wave's-files rule) and the Wave 1.13-C
// top-level `crate::inbox` AI-extraction stub (different again — that one is
// an in-process queue feeding 1.13-A's bus once it lands).
pub mod identity;
pub mod inbox_store;
// === end wave 1.13-A ===

mod error;
mod paths;
mod runner;

pub use error::AppError;
pub use paths::AppPaths;
pub use runner::{ProcessRegistry, RunHandle};

/// Shared, cross-command application state. Plugins and screens read from this
/// via `app.state::<AppState>()`. Designed to be cheaply cloneable (Arc-wrap).
#[derive(Clone)]
pub struct AppState {
    pub paths: Arc<AppPaths>,
    pub runs: Arc<ProcessRegistry>,
    pub watchers: Arc<RwLock<fs::WatcherTable>>,
    pub bots: Arc<RwLock<bot::BotTable>>,
    pub downloads: Arc<parking_lot::Mutex<whisper_model::DownloadTable>>,
    pub http: reqwest::Client,
    /// v1.6.0: control surface for the background memory sync ticker.
    /// Lives in `commands::sync`; held here so commands can reach it via
    /// `state.sync.dirty.notify_waiters()` without juggling globals.
    pub sync: Arc<sync::SyncControl>,
    /// v1.6.0: shared with the localhost ws_server so it can resolve the
    /// live memory root. `Some(repo)` ⇒ team mode (ws server reads
    /// `<repo>/memory`); `None` ⇒ solo mode (ws server falls back to
    /// `<home>/.tangerine-memory`). Mutated by `sync_start`/`sync_stop`.
    pub ws_team_repo: Arc<parking_lot::Mutex<Option<PathBuf>>>,
    /// v1.6.0: port the ws_server actually bound to (may differ from 7780
    /// if the default was busy). `None` until the server is up. The
    /// `get_ws_port` Tauri command reads this so the frontend can debug.
    pub ws_port: Arc<parking_lot::Mutex<Option<u16>>>,
    /// v1.7.0: handle for the background RMS daemon (heartbeat that
    /// rebuilds the timeline index, refreshes pending alerts, generates
    /// daily briefs). Installed by `main.rs` after the AppState is built.
    pub daemon: Arc<daemon::DaemonSlot>,
    // === v1.14.1 round-2 ===
    // v1.14 R2 perf — in-process mtime-keyed cache for `is_sample_md_file`
    // (commands::memory). Key = absolute file path; value = (mtime, sample
    // flag). Survives across `memory_tree` invocations within the same
    // session, clears on app restart (first-launch cold cost is acceptable).
    // RwLock so the read path scales across concurrent Tauri command calls
    // without a serialization point. Eviction is dirt simple: if len > 10K
    // we wipe and rebuild — realistic memory dirs are well under that.
    pub sample_cache: Arc<RwLock<HashMap<PathBuf, (SystemTime, bool)>>>,
    // === end v1.14.1 round-2 ===
    // === v1.14.4 round-5 ===
    // v1.14 R5 perf — sibling cache for `compute_backlinks`. R2 nuked the
    // per-file head read cost in `memory_tree`; R5 nukes the equivalent in
    // backlinks (which was the next-weakest hot path: read_to_string on
    // every .md every call, no head cap, O(N·BodySize)).
    // Key = absolute file path; value = (mtime, Arc<CachedFileLinks>).
    // Same eviction policy + same RwLock contract as `sample_cache`. The
    // value is `Arc` so concurrent reads can clone the handle out from
    // under the read lock without copying the cached body string.
    pub link_cache: crate::commands::memory::LinkCache,
    // === end v1.14.4 round-5 ===
}

impl AppState {
    fn build(app: &AppHandle<impl Runtime>) -> Result<Self, AppError> {
        let paths = AppPaths::resolve(app)?;
        Ok(Self {
            paths: Arc::new(paths),
            runs: Arc::new(ProcessRegistry::default()),
            watchers: Arc::new(RwLock::new(Default::default())),
            bots: Arc::new(RwLock::new(Default::default())),
            downloads: Arc::new(parking_lot::Mutex::new(Default::default())),
            http: reqwest::Client::builder()
                .user_agent("TangerineMeeting/1.6")
                .build()
                .map_err(|e| AppError::internal("http_init", e.to_string()))?,
            sync: Arc::new(sync::SyncControl::default()),
            ws_team_repo: Arc::new(parking_lot::Mutex::new(None)),
            ws_port: Arc::new(parking_lot::Mutex::new(None)),
            daemon: Arc::new(daemon::DaemonSlot::default()),
            // === v1.14.1 round-2 ===
            sample_cache: Arc::new(RwLock::new(HashMap::new())),
            // === end v1.14.1 round-2 ===
            // === v1.14.4 round-5 ===
            link_cache: Arc::new(RwLock::new(HashMap::new())),
            // === end v1.14.4 round-5 ===
        })
    }
}

/// Tauri `setup` callback. T1 plugs this in via `.setup(commands::setup_state)`.
pub fn setup_state<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let state = AppState::build(&app.handle().clone())
        .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
    tracing::info!(
        meetings_repo = %state.paths.meetings_repo.display(),
        config_path = %state.paths.config_path.display(),
        "AppState initialised"
    );
    app.manage(state);
    Ok(())
}

/// Returns the Tauri `invoke_handler` macro expansion bundling every command
/// owned by T3. Note: Tauri's macro must see commands at the call-site, so
/// this function returns the closure produced by `generate_handler!`.
#[macro_export]
macro_rules! tmi_invoke_handler {
    () => {
        ::tauri::generate_handler![
            // tmi process
            $crate::commands::tmi::run_tmi,
            $crate::commands::tmi::run_tmi_send_stdin,
            $crate::commands::tmi::run_tmi_kill,
            // bot process
            $crate::commands::bot::start_bot,
            $crate::commands::bot::stop_bot,
            $crate::commands::bot::bot_status,
            // filesystem
            $crate::commands::meetings::list_meetings,
            $crate::commands::meetings::read_meeting,
            $crate::commands::meetings::read_meeting_file,
            $crate::commands::fs::tail_file,
            $crate::commands::fs::untail_file,
            $crate::commands::fs::watch_meeting,
            $crate::commands::fs::unwatch_meeting,
            // config
            $crate::commands::config::get_config,
            $crate::commands::config::set_config,
            // env / secrets (de-scoped to .env file — see env.rs)
            $crate::commands::env::get_secret,
            $crate::commands::env::set_secret,
            $crate::commands::env::write_env_file,
            // external + update
            $crate::commands::external::open_external,
            $crate::commands::external::open_in_editor,
            $crate::commands::external::show_in_folder,
            $crate::commands::external::system_notify,
            $crate::commands::external::export_debug_bundle,
            $crate::commands::update::check_updates,
            // wizard helpers
            $crate::commands::external::detect_claude_cli,
            $crate::commands::external::detect_node_runtime,
            $crate::commands::external::validate_target_repo,
            $crate::commands::discord::poll_discord_bot_presence,
            $crate::commands::discord::validate_discord_bot_token,
            $crate::commands::discord::validate_whisper_key,
            // local whisper model (faster-whisper)
            $crate::commands::whisper_model::get_whisper_model_status,
            $crate::commands::whisper_model::download_whisper_model,
            $crate::commands::whisper_model::cancel_whisper_download,
            // memory layer (sample seeding + root resolution)
            $crate::commands::memory::resolve_memory_root,
            $crate::commands::memory::init_memory_with_samples,
            // v2.0-alpha.1 — layered memory listing (team + personal).
            $crate::commands::memory::list_atoms,
            // === wave 21 === — Obsidian-style /memory tree + backlinks
            $crate::commands::memory::memory_tree,
            $crate::commands::memory::compute_backlinks,
            // === end wave 21 ===
            // === wave 23 === — visual atom graph data for /memory graph view
            $crate::commands::memory::memory_graph_data,
            // === end wave 23 ===
            // v1.6.0 — git ops
            $crate::commands::git::git_check,
            $crate::commands::git::git_clone,
            $crate::commands::git::git_pull,
            $crate::commands::git::git_push,
            $crate::commands::git::git_status,
            $crate::commands::git::git_commit_all,
            $crate::commands::git::git_init_and_push,
            // v1.6.0 — github oauth + repo create
            $crate::commands::github::github_device_flow_start,
            $crate::commands::github::github_device_flow_poll,
            $crate::commands::github::github_create_repo,
            // v1.6.0 — background sync ticker
            $crate::commands::sync::sync_start,
            $crate::commands::sync::sync_stop,
            $crate::commands::sync::sync_kick,
            $crate::commands::sync::sync_status,
            // === wave 10 === v1.10 git sync auto-layer
            $crate::commands::git_sync::git_sync_status,
            $crate::commands::git_sync::git_sync_init,
            $crate::commands::git_sync::git_sync_pull,
            $crate::commands::git_sync::git_sync_push,
            $crate::commands::git_sync::git_sync_history,
            // === end wave 10 ===
            // === wave 21 === — per-file git log for /brain inline history
            $crate::commands::git_sync::git_log_for_file,
            // === end wave 21 ===
            // v1.6.0 — invite link codec
            $crate::commands::invite::generate_invite,
            $crate::commands::invite::parse_invite,
            // v1.6.0 — ws server (browser extension bridge)
            $crate::commands::ws::get_ws_port,
            // v1.7.0 — RMS daemon
            $crate::commands::daemon::daemon_status,
            $crate::commands::daemon::daemon_kick,
            // Stage 1 Wave 3 — view-layer commands
            $crate::commands::views::read_timeline_today,
            $crate::commands::views::read_timeline_recent,
            $crate::commands::views::read_brief,
            $crate::commands::views::read_alignment,
            $crate::commands::views::read_pending_alerts,
            $crate::commands::views::read_people_list,
            $crate::commands::views::read_person,
            $crate::commands::views::read_projects_list,
            $crate::commands::views::read_project,
            $crate::commands::views::read_threads_list,
            $crate::commands::views::read_thread,
            $crate::commands::views::mark_atom_viewed,
            $crate::commands::views::mark_atom_acked,
            $crate::commands::views::mark_user_opened,
            $crate::commands::views::read_cursor,
            $crate::commands::views::read_whats_new,
            // v1.21.0 — manual capture surface (canvas-bottom Capture input).
            $crate::commands::views::capture_manual_atom,
            // === v1.17.1 ===
            // TEAM_INDEX.md auto-write — frictionless AI session bridge.
            // Manual surface invoked from the setup wizard's "show me the
            // CLAUDE.md import line" card; the daemon also calls the
            // sibling `write_team_index_to` directly after each successful
            // index rebuild so the file stays warm without a Tauri round
            // trip.
            $crate::commands::team_index::write_team_index,
            // === end v1.17.1 ===
            // v1.8 Phase 1 — AI tools detection (sidebar status panel)
            $crate::commands::ai_tools::detect_ai_tools,
            $crate::commands::ai_tools::get_ai_tool_status,
            // === v1.16 — co_thinker_dispatch removed (LLM borrow gone) ===
            // === Phase 2-B writeback (Slack + Calendar) ===
            $crate::commands::writeback_slack_calendar::slack_writeback_brief,
            $crate::commands::writeback_slack_calendar::slack_writeback_summary,
            $crate::commands::writeback_slack_calendar::calendar_writeback_summary,
            // === end Phase 2-B writeback ===
            // === Phase 2-A writeback (GitHub + Linear) ===
            $crate::commands::writeback::writeback_decision,
            $crate::commands::writeback::read_writeback_log,
            $crate::commands::writeback::set_writeback_watcher,
            // === end Phase 2-A writeback ===
            // === Phase 2-C real-wire (Notion + Loom + Zoom) ===
            $crate::commands::notion::notion_get_config,
            $crate::commands::notion::notion_set_config,
            $crate::commands::notion::notion_validate_token,
            $crate::commands::notion::notion_list_databases,
            $crate::commands::notion::notion_capture,
            $crate::commands::notion::notion_writeback_decision,
            $crate::commands::loom::loom_get_config,
            $crate::commands::loom::loom_set_config,
            $crate::commands::loom::loom_validate_token,
            $crate::commands::loom::loom_pull_transcript,
            $crate::commands::loom::loom_capture,
            $crate::commands::zoom::zoom_get_config,
            $crate::commands::zoom::zoom_set_config,
            $crate::commands::zoom::zoom_validate_credentials,
            $crate::commands::zoom::zoom_capture,
            // === end Phase 2-C real-wire ===
            // === Phase 2-D new sources (Email + Voice notes) ===
            // Email: IMAP digest. Test connection stores the app password
            // in the OS keychain; fetch_recent runs daily via the daemon
            // hook (see crate::daemon for the heartbeat tick).
            $crate::sources::email::email_test_connection,
            $crate::sources::email::email_fetch_recent,
            // Voice notes: in-app recorder + local Whisper transcription.
            // The frontend sends a base64 audio blob; we hand it off to the
            // existing python -m tmi.transcribe module (no new whisper dep).
            $crate::sources::voice_notes::voice_notes_record_and_transcribe,
            $crate::sources::voice_notes::voice_notes_list_recent,
            // === end Phase 2-D new sources ===
            // === v1.16 — co_thinker engine removed (no more LLM borrow) ===
            // === Phase 4-B canvas surface ===
            $crate::commands::canvas::canvas_list_projects,
            $crate::commands::canvas::canvas_list_topics,
            $crate::commands::canvas::canvas_load_topic,
            $crate::commands::canvas::canvas_save_topic,
            // === end Phase 4-B canvas surface ===
            // === v1.16 — ambient input layer removed (LLM borrow gone) ===
            // === Phase 4-C agi peer + propose lock ===
            $crate::commands::canvas_agi::canvas_propose_lock,
            $crate::commands::canvas_agi::agi_throw_sticky,
            $crate::commands::canvas_agi::agi_comment_sticky,
            // === end Phase 4-C agi peer + propose lock ===
            // === v1.9 P1-A telemetry ===
            $crate::commands::telemetry::telemetry_log,
            $crate::commands::telemetry::telemetry_read_window,
            $crate::commands::telemetry::telemetry_clear,
            // === end v1.9 P1-A telemetry ===
            // === v1.9 P3-A suppression ===
            $crate::commands::suppression::suppression_check,
            $crate::commands::suppression::suppression_recompute,
            $crate::commands::suppression::suppression_clear,
            $crate::commands::suppression::suppression_list,
            // === end v1.9 P3-A suppression ===
            // === v2.0-beta.2 active agents ===
            $crate::commands::active_agents::get_active_agents,
            // === end v2.0-beta.2 active agents ===
            // === v2.5 review ===
            $crate::commands::review::review_create,
            $crate::commands::review::review_cast_vote,
            $crate::commands::review::review_get,
            $crate::commands::review::review_list_open,
            $crate::commands::review::review_promote,
            // === end v2.5 review ===
            // === wave 1.13-B ===
            // L4 review workflow (frontmatter-native).
            $crate::commands::review::review_propose,
            $crate::commands::review::review_vote,
            $crate::commands::review::review_workflow_status,
            $crate::commands::review::review_list_pending,
            $crate::commands::review::review_list_proposed_by,
            $crate::commands::review::review_list_by_status,
            // L5 inline comment threads.
            $crate::commands::comments::comments_list,
            $crate::commands::comments::comments_create,
            $crate::commands::comments::comments_resolve,
            $crate::commands::comments::comments_unresolve,
            $crate::commands::comments::comments_archive,
            // === end wave 1.13-B ===
            // === v2.5 cloud_sync ===
            $crate::cloud_sync::cloud_sync_get_config,
            $crate::cloud_sync::cloud_sync_set_config,
            $crate::cloud_sync::cloud_sync_init,
            $crate::cloud_sync::cloud_sync_pull,
            $crate::cloud_sync::cloud_sync_push,
            // === end v2.5 cloud_sync ===
            // === v2.5 auth + billing ===
            $crate::commands::auth::auth_sign_in_email_password,
            $crate::commands::auth::auth_sign_up,
            $crate::commands::auth::auth_sign_in_oauth,
            $crate::commands::auth::auth_verify_email,
            $crate::commands::auth::auth_sign_out,
            $crate::commands::auth::auth_session,
            $crate::commands::billing::billing_subscribe,
            $crate::commands::billing::billing_cancel,
            $crate::commands::billing::billing_status,
            $crate::commands::billing::billing_trial_start,
            $crate::commands::billing::billing_webhook,
            $crate::commands::billing::billing_reconcile,
            $crate::commands::billing::email_verify_send,
            $crate::commands::billing::email_verify_confirm,
            $crate::commands::billing::email_verify_status,
            // === end v2.5 auth + billing ===
            // === v3.0 personal agents ===
            $crate::commands::personal_agents::personal_agents_scan_all,
            $crate::commands::personal_agents::personal_agents_capture_cursor,
            $crate::commands::personal_agents::personal_agents_capture_claude_code,
            $crate::commands::personal_agents::personal_agents_capture_codex,
            $crate::commands::personal_agents::personal_agents_capture_windsurf,
            $crate::commands::personal_agents::personal_agents_get_settings,
            $crate::commands::personal_agents::personal_agents_set_settings,
            $crate::commands::personal_agents::personal_agents_set_watcher,
            // === end v3.0 personal agents ===
            // === v3.0 wave 2 personal agents ===
            $crate::commands::personal_agents::personal_agents_capture_devin,
            $crate::commands::personal_agents::personal_agents_devin_webhook,
            $crate::commands::personal_agents::personal_agents_capture_replit,
            $crate::commands::personal_agents::personal_agents_capture_apple_intelligence,
            $crate::commands::personal_agents::personal_agents_apple_intel_hook,
            $crate::commands::personal_agents::personal_agents_capture_ms_copilot,
            // === end v3.0 wave 2 personal agents ===
            // === v3.0 external world ===
            $crate::commands::external::external_rss_subscribe,
            $crate::commands::external::external_rss_unsubscribe,
            $crate::commands::external::external_rss_list_feeds,
            $crate::commands::external::external_rss_fetch_now,
            $crate::commands::external::external_podcast_subscribe,
            $crate::commands::external::external_podcast_unsubscribe,
            $crate::commands::external::external_podcast_list_feeds,
            $crate::commands::external::external_podcast_fetch_now,
            $crate::commands::external::external_youtube_capture,
            $crate::commands::external::external_article_capture,
            // === end v3.0 external world ===
            // === v3.5 marketplace ===
            $crate::commands::marketplace::marketplace_list_templates,
            $crate::commands::marketplace::marketplace_install_template,
            $crate::commands::marketplace::marketplace_is_installed,
            $crate::commands::marketplace::marketplace_uninstall_template,
            $crate::commands::marketplace::marketplace_publish_template,
            $crate::commands::marketplace::marketplace_get_launch_state,
            // === end v3.5 marketplace ===
            // === v3.5 branding ===
            $crate::commands::branding::branding_get_config,
            $crate::commands::branding::branding_apply,
            $crate::commands::branding::branding_reset_to_default,
            $crate::commands::branding::branding_validate_license,
            // === end v3.5 branding ===
            // === v3.5 sso ===
            $crate::commands::sso::sso_set_config,
            $crate::commands::sso::sso_get_config,
            $crate::commands::sso::sso_list_configs,
            $crate::commands::sso::sso_validate_saml_response,
            $crate::commands::sso::sso_validate_saml_response_with_result,
            // === end v3.5 sso ===
            // === v3.5 audit ===
            $crate::commands::audit::audit_append,
            $crate::commands::audit::audit_read_window,
            $crate::commands::audit::audit_read_day,
            $crate::commands::audit::audit_search,
            $crate::commands::audit::audit_log_export,
            $crate::commands::audit::audit_verify_chain,
            $crate::commands::audit::audit_get_region,
            $crate::commands::audit::audit_set_region,
            // === end v3.5 audit ===
            // === wave 11 (trimmed in v1.16) ===
            // v1.10.2 — first-run setup wizard. v1.16 PIVOT: dropped
            // `setup_wizard_test_channel` (Tangerine no longer borrows the
            // host LLM via MCP sampling, so there is nothing to test). The
            // remaining 4 commands cover detection, no-op auto-configure
            // (kept for React call-site compatibility, capture is read-only
            // from log files), Ollama install hint, and persisted state.
            $crate::commands::setup_wizard::setup_wizard_detect,
            $crate::commands::setup_wizard::setup_wizard_auto_configure_mcp,
            $crate::commands::setup_wizard::setup_wizard_install_ollama_hint,
            $crate::commands::setup_wizard::setup_wizard_persist_state,
            // === end wave 11 ===
            // === v1.15.0 wave 1.3 (no-op stubs in v1.16) ===
            // 8-tool MCP auto-configure + handshake — NO-OP STUBS as of
            // v1.16. The npm package `tangerine-mcp` was removed (W1A2),
            // so writing an `npx tangerine-mcp` MCP entry would point at
            // a non-existent binary. Capture is read-only from log files;
            // the future capture-side handshake lands in W2.
            $crate::commands::setup_wizard::setup_wizard_v15_auto_configure_mcp,
            $crate::commands::setup_wizard::mcp_server_handshake,
            // === end v1.15.0 wave 1.3 ===
            // === wave 13 ===
            // v1.10.3 — populated-app demo seed. 3 commands. See
            // `demo_seed.rs` for the doc comment + invariants.
            $crate::commands::demo_seed::demo_seed_check,
            $crate::commands::demo_seed::demo_seed_install,
            $crate::commands::demo_seed::demo_seed_clear,
            // === end wave 13 ===
            // === wave 15 ===
            // v1.10.4 — Cmd+K full memory search. 1 command. See
            // `search.rs` for the scoring algorithm + soft-fail
            // contract. Frontend wraps it in `lib/tauri.ts::searchAtoms`.
            $crate::commands::search::search_atoms,
            // === end wave 15 ===
            // === wave 16 ===
            // Wave 16 — activity event bus read side. The write side
            // (atom_written events) flows through the
            // `activity:atom_written` Tauri event emitted from
            // `crate::activity::record_atom_written`; the React side
            // hydrates initial state via this single command.
            $crate::commands::activity::activity_recent,
            // === end wave 16 ===
            // === wave 18 ===
            // Conversational onboarding agent — single command that turns
            // a free-form user message ("github=daizhe, repo=foo,
            // primary=Claude Code") into action dispatches against the
            // existing setup wizard / git_sync / whisper_model surfaces.
            $crate::commands::onboarding_chat::onboarding_chat_turn,
            // === end wave 18 ===
            // === wave 24 ===
            // Daily notes + templates. ensure_today is idempotent (safe to
            // call from /today's mount + the co-thinker heartbeat); list
            // returns reverse-chronological summaries for the calendar
            // widget; templates_list/templates_apply walk the bundled
            // resources/sample-memory/templates/ dir and copy into the
            // user's memory root respectively.
            $crate::commands::daily_notes::daily_notes_ensure_today,
            $crate::commands::daily_notes::daily_notes_list,
            $crate::commands::daily_notes::daily_notes_read,
            $crate::commands::daily_notes::daily_notes_save,
            $crate::commands::daily_notes::templates_list,
            $crate::commands::daily_notes::templates_apply,
            // === end wave 24 ===
            // === wave 1.13-D ===
            // v1.13 — team presence (Path B git-mediated).
            $crate::commands::presence::presence_emit,
            $crate::commands::presence::presence_list_active,
            // === end wave 1.13-D ===
            // === wave 1.13-A ===
            // Identity layer: current user + team roster + persisted profile.
            $crate::commands::identity::identity_get_current_user,
            $crate::commands::identity::identity_team_roster,
            $crate::commands::identity::identity_set_profile,
            // Inbox event store: list / emit / mark-read / archive / mark-all-read.
            // The @mention parser fires `inbox_emit` once per mentioned user
            // when an atom is submitted. The /inbox React route consumes
            // `inbox_list`. The AppShell listener subscribes to the
            // `inbox:event_created` Tauri event for live toast + system
            // notifications.
            $crate::commands::inbox_store::inbox_list,
            $crate::commands::inbox_store::inbox_emit,
            $crate::commands::inbox_store::inbox_mark_read,
            $crate::commands::inbox_store::inbox_archive,
            $crate::commands::inbox_store::inbox_mark_all_read,
            // === end wave 1.13-A ===
            // === wave 1.13-E ===
            // OS-keychain-backed source token store. The set/get/delete trio
            // is what the chat-driven onboarding (`onboarding_chat`) hands
            // off to when the user pastes Lark / Zoom / Teams / Slack /
            // GitHub credentials inline. Privacy panel reads presence-only
            // (never the token value) via secret_store_get_oauth.
            //
            // === v1.13.5 round-5 === — Round 5 audit confirmed the FRONTEND
            // never invokes these directly; all frontend keychain access
            // routes through `onboarding_chat_turn` which then calls these
            // as in-process Rust functions (see onboarding_chat.rs). Kept
            // registered for v1.14 chat-bypass OAuth UI (paste-token modal
            // in Settings → Sources). Don't delete.
            $crate::commands::secret_store::secret_store_set_oauth,
            $crate::commands::secret_store::secret_store_get_oauth,
            $crate::commands::secret_store::secret_store_delete_oauth,
            // Privacy panel data: enumerate the 5 v1.13-E sources, return
            // their token presence + a snapshot of "what's local vs what
            // leaves the machine" for the React-side diagram.
            $crate::commands::privacy::privacy_get_overview,
            $crate::commands::privacy::privacy_set_telemetry_opt_out,
            $crate::commands::privacy::privacy_verify_local_execution,
            // === end wave 1.13-E ===
        ]
    };
}

/// Shape returned by `read_meeting`. Mirrors APP-INTERFACES.md §4.1.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingState {
    pub id: String,
    pub dir: PathBuf,
    pub meeting: serde_json::Value,
    pub status: serde_json::Value,
    pub intents: Vec<IntentInfo>,
    pub transcript_lines: u64,
    pub observations_lines: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IntentInfo {
    pub alias: String,
    pub path: PathBuf,
    pub locked: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MeetingListItem {
    pub id: String,
    pub title: String,
    pub state: String,
    pub created_at: Option<String>,
    pub participants: Vec<String>,
    pub transcript_lines: u64,
}
