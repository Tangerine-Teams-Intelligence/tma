//! Perf (API_SURFACE_SPEC §5): `writeback_decision` is the capture/upstream
//! bucket → 10 s p95 (one upstream POST). `read_writeback_log` is a read
//! command → 50 ms p95. `set_writeback_watcher` is a write command → 200 ms p95.
//!
//! Tauri commands for v1.8 Phase 2-A writeback (GitHub + Linear).
//!
//! Three commands exposed:
//!   * `writeback_decision(decision_path)` — manual trigger from the
//!     Sources/GitHub or Sources/Linear page. Reads the file, dispatches
//!     to the right adapter, records the outcome.
//!   * `read_writeback_log(limit)` — returns the most-recent N entries
//!     for the UI's "Writeback log" panel.
//!   * `set_writeback_watcher(enabled)` — turns the filesystem watcher on
//!     or off. Called by the toggle in the Sources/<source> page after the
//!     user flips the switch and the YAML config has been updated.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::sources::watcher::{WritebackWatcherConfig, WritebackWatcherSlot};
use crate::sources::writeback_log::{WritebackLog, WritebackLogEntry};
use crate::sources::{github, linear, parse_decision_frontmatter, watcher, WritebackOutcome};

use super::{AppError, AppState};

/// Resolve `~/.tangerine-memory` (or the team-mode override) — same logic
/// the rest of the app uses. We don't import the fn from `commands::memory`
/// because it's a private free fn there; replicating it here keeps this
/// module self-contained.
fn resolve_memory_root_path(state: &AppState) -> Result<PathBuf, AppError> {
    if let Some(team) = state.ws_team_repo.lock().clone() {
        return Ok(team.join("memory"));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

fn watcher_config(state: &AppState) -> Result<WritebackWatcherConfig, AppError> {
    Ok(WritebackWatcherConfig {
        memory_root: resolve_memory_root_path(state)?,
        config_path: state.paths.config_path.clone(),
        env_file: state.paths.env_file.clone(),
    })
}

#[derive(Debug, Deserialize)]
pub struct WritebackDecisionArgs {
    /// Path to the decision file. Either an absolute path OR a path
    /// relative to the memory root (e.g. `decisions/foo.md`). The
    /// frontend usually has the absolute path; we accept both.
    pub decision_path: String,
}

#[tauri::command]
pub async fn writeback_decision(
    state: State<'_, AppState>,
    args: WritebackDecisionArgs,
) -> Result<WritebackOutcome, AppError> {
    let memory_root = resolve_memory_root_path(&state)?;
    let abs_path = PathBuf::from(&args.decision_path);
    let abs_path = if abs_path.is_absolute() {
        abs_path
    } else {
        memory_root.join(&args.decision_path)
    };
    let raw = std::fs::read_to_string(&abs_path).map_err(|e| {
        AppError::user(
            "writeback_read_failed",
            format!("{}: {}", abs_path.display(), e),
        )
    })?;
    let filename = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let prov = match parse_decision_frontmatter(&raw, &filename) {
        Some(p) => p,
        None => {
            return Ok(WritebackOutcome::NotApplicable {
                reason: "decision file has no `source: github|linear` frontmatter".into(),
            });
        }
    };
    let rel_path = format!("decisions/{}", filename);
    let log = WritebackLog::new(&memory_root);

    // Dedup — if a prior Posted entry exists, return AlreadyDone without
    // a second HTTP call.
    if let Some(prior) = log.lookup(&rel_path)? {
        if let WritebackOutcome::Posted { external_url, .. } = &prior.outcome {
            let outcome = WritebackOutcome::AlreadyDone {
                external_url: external_url.clone(),
            };
            let _ = log.record(&rel_path, &prov.source, &prov.external_id, &outcome);
            return Ok(outcome);
        }
    }

    let outcome = match prov.source.as_str() {
        "github" => github::writeback_decision(&state.http, &state.paths.config_path, &prov)
            .await
            .unwrap_or_else(|e| WritebackOutcome::Failed {
                error: e.to_string(),
            }),
        "linear" => linear::writeback_decision(
            &state.http,
            &state.paths.config_path,
            &state.paths.env_file,
            &prov,
        )
        .await
        .unwrap_or_else(|e| WritebackOutcome::Failed {
            error: e.to_string(),
        }),
        other => WritebackOutcome::NotApplicable {
            reason: format!("source '{}' not wired for writeback", other),
        },
    };

    let _ = log.record(&rel_path, &prov.source, &prov.external_id, &outcome);
    Ok(outcome)
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ReadWritebackLogArgs {
    /// Default 5 — the Sources page only renders the most recent five.
    pub limit: usize,
    /// Optional filter — `github` or `linear`. None returns both.
    pub source: Option<String>,
}

impl Default for ReadWritebackLogArgs {
    fn default() -> Self {
        Self {
            limit: 5,
            source: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ReadWritebackLogResult {
    pub entries: Vec<WritebackLogEntry>,
    pub log_path: String,
}

#[tauri::command]
pub async fn read_writeback_log(
    state: State<'_, AppState>,
    args: ReadWritebackLogArgs,
) -> Result<ReadWritebackLogResult, AppError> {
    let memory_root = resolve_memory_root_path(&state)?;
    let log = WritebackLog::new(&memory_root);
    let mut entries = log.entries()?;
    if let Some(want) = args.source.as_deref() {
        entries.retain(|e| e.source == want);
    }
    // Most recent first, capped at limit.
    entries.reverse();
    let limit = if args.limit == 0 { 5 } else { args.limit.min(50) };
    entries.truncate(limit);
    Ok(ReadWritebackLogResult {
        entries,
        log_path: log.path().to_string_lossy().to_string(),
    })
}

#[derive(Debug, Deserialize)]
pub struct SetWritebackWatcherArgs {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct SetWritebackWatcherResult {
    pub running: bool,
}

#[tauri::command]
pub async fn set_writeback_watcher<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    args: SetWritebackWatcherArgs,
) -> Result<SetWritebackWatcherResult, AppError> {
    // The slot lives in AppState; install lazily so the desktop app
    // doesn't pay the cost when the user never enables writeback.
    let slot: tauri::State<WritebackWatcherSlot> = match app.try_state::<WritebackWatcherSlot>() {
        Some(s) => s,
        None => {
            app.manage(WritebackWatcherSlot::default());
            app.state::<WritebackWatcherSlot>()
        }
    };

    if !args.enabled {
        slot.stop();
        return Ok(SetWritebackWatcherResult { running: false });
    }
    if slot.is_running() {
        return Ok(SetWritebackWatcherResult { running: true });
    }
    let cfg = watcher_config(&state)?;
    let handle = watcher::start(app.clone(), cfg, state.http.clone())?;
    slot.install(handle);
    Ok(SetWritebackWatcherResult { running: true })
}
