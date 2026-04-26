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

// v1.6.0 team memory sync.
pub mod git;
pub mod github;
pub mod sync;
pub mod invite;
pub mod ws;

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
