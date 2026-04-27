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

use std::path::PathBuf;
use std::sync::Arc;

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

// === Phase 3-A session borrowing (LLM dispatch) ===
// v1.8 Phase 3: thin Tauri wrapper around `crate::agi::session_borrower`.
// Sibling agents in Phase 3-B own the co-thinker brain + observations
// extractor under `crate::agi::*`; Phase 3-C wires the React `/co-thinker`
// route. This module only exposes the dispatch entry point.
pub mod co_thinker_dispatch;
// === end Phase 3-A session borrowing ===

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

// v1.6.0 team memory sync.
pub mod git;
pub mod github;
pub mod sync;
pub mod invite;
pub mod ws;

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

// === Phase 3-B co-thinker engine ===
// v1.8 Phase 3: the persistent stateful AGI brain. Tauri command surface for
// the /co-thinker route — read/write the brain.md, manually trigger a
// heartbeat, fetch status. The engine itself lives in `crate::agi::co_thinker`;
// daemon-driven ticks are wired in `crate::daemon::do_heartbeat`. P3-A's
// session-borrower dispatcher (consumed by the engine) is independent.
pub mod co_thinker;
// === end Phase 3-B co-thinker engine ===

// === Phase 4-B canvas surface ===
// v1.8 Phase 4-B: per-project ideation surface (sticky notes + threading).
// React side at `app/src/routes/canvas.tsx` + `app/src/components/canvas/*`;
// the inert filesystem layer at `crate::agi::canvas`. Sibling P4-C agent
// wires AGI peer behaviors (the AGI participates as a peer, posting stickies
// and replies) on top of the same on-disk file shape — that lives in P4-C's
// own module and is independent of this command surface.
pub mod canvas;
// === end Phase 4-B canvas surface ===

// === Phase 4-A ambient ===
// v1.8 Phase 4-A: ambient input layer. The whole app is a chat surface,
// but there is no chatbot tab — every textarea / contenteditable / palette
// input is implicitly an AGI entry point. This module exposes the single
// command (`agi_analyze_input`) that the React-side observer
// (`AmbientInputObserver`) calls once per debounced edit. The actual
// dispatch goes through `crate::agi::session_borrower::dispatch` with a
// fixed AMBIENT system prompt (`crate::agi::ambient`).
pub mod agi_ambient;
// === end Phase 4-A ambient ===

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
            // v1.8 Phase 1 — AI tools detection (sidebar status panel)
            $crate::commands::ai_tools::detect_ai_tools,
            $crate::commands::ai_tools::get_ai_tool_status,
            // === Phase 3-A session borrowing (LLM dispatch) ===
            $crate::commands::co_thinker_dispatch::co_thinker_dispatch,
            // === end Phase 3-A session borrowing ===
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
            // === Phase 3-B co-thinker engine ===
            $crate::commands::co_thinker::co_thinker_read_brain,
            $crate::commands::co_thinker::co_thinker_write_brain,
            $crate::commands::co_thinker::co_thinker_trigger_heartbeat,
            $crate::commands::co_thinker::co_thinker_status,
            // === end Phase 3-B co-thinker engine ===
            // === Phase 4-B canvas surface ===
            $crate::commands::canvas::canvas_list_projects,
            $crate::commands::canvas::canvas_list_topics,
            $crate::commands::canvas::canvas_load_topic,
            $crate::commands::canvas::canvas_save_topic,
            // === end Phase 4-B canvas surface ===
            // === Phase 4-A ambient ===
            $crate::commands::agi_ambient::agi_analyze_input,
            // === end Phase 4-A ambient ===
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
