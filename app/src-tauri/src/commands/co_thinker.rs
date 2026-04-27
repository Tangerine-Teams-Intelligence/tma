//! v1.8 Phase 3-B — Tauri command surface for the co-thinker brain.
//!
//! Exposed to the React `/co-thinker` route (P3-C):
//!   * `co_thinker_read_brain`        — read the full brain.md
//!   * `co_thinker_write_brain`       — user-edited brain.md persists here
//!   * `co_thinker_trigger_heartbeat` — manual "Trigger heartbeat now" button
//!   * `co_thinker_status`            — last-heartbeat / next-heartbeat / size
//!
//! State note: the engine itself isn't held in `AppState` — instead each
//! command spins up a short-lived `CoThinkerEngine` against the resolved
//! memory root. The daemon owns a long-lived engine for its own ticks (see
//! `crate::daemon::do_heartbeat`'s `co_thinker_tick`). Keeping these separate
//! means the manual-trigger path is independent of daemon state, which was
//! the simplest contract for /co-thinker UI to reason about.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::agi::co_thinker::{CoThinkerEngine, HeartbeatCadence, HeartbeatOutcome};
use crate::agi::observations;
use crate::agi::templates::common::TauriEventSink;

use super::AppError;

/// Resolve the memory root the same way `commands::memory` does.
fn memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Read the full co-thinker brain doc as plain markdown. Returns the seed
/// doc when the file doesn't exist yet so the frontend always has something
/// to render.
#[tauri::command]
pub async fn co_thinker_read_brain() -> Result<String, AppError> {
    let root = memory_root()?;
    let engine = CoThinkerEngine::new(root);
    engine.read_brain_doc()
}

/// Replace the brain doc with `content`. Used when the user manually edits
/// brain.md from the /co-thinker route. We do not validate structure here —
/// the user is allowed to write whatever they want; the next heartbeat will
/// rebuild from atoms anyway.
#[tauri::command]
pub async fn co_thinker_write_brain(content: String) -> Result<(), AppError> {
    let root = memory_root()?;
    let engine = CoThinkerEngine::new(root);
    engine.write_brain_doc(&content)
}

/// Run one heartbeat synchronously, returning the outcome. The frontend's
/// "Trigger heartbeat now" button awaits this — the engine throttle ensures
/// concurrent invocations short-circuit cleanly.
///
/// v1.9.0-beta.2: install a `TauriEventSink` so the rule-based templates'
/// `template_match` events reach the frontend listener in `AppShell.tsx`
/// during a manual trigger. The daemon-driven path wires the same sink
/// from `daemon::start` once an `AppHandle` is in scope at boot.
#[tauri::command]
pub async fn co_thinker_trigger_heartbeat<R: Runtime>(
    app: AppHandle<R>,
    primary_tool_id: Option<String>,
) -> Result<HeartbeatOutcome, AppError> {
    let root = memory_root()?;
    let mut engine = CoThinkerEngine::new(root);
    engine.set_event_sink(Arc::new(TauriEventSink::new(app)));
    engine
        .heartbeat(HeartbeatCadence::Manual, primary_tool_id)
        .await
}

/// Lightweight status snapshot for the /co-thinker route's header strip.
/// All fields are best-effort (`None` / `0` on read errors).
#[derive(Debug, Serialize)]
pub struct CoThinkerStatus {
    pub last_heartbeat_at: Option<String>,
    pub next_heartbeat_at: Option<String>,
    pub brain_doc_size: u64,
    pub observations_today: u32,
}

#[tauri::command]
pub async fn co_thinker_status() -> Result<CoThinkerStatus, AppError> {
    let root = memory_root()?;
    let brain_path = root.join("agi").join("co-thinker.md");
    let brain_doc_size = std::fs::metadata(&brain_path).map(|m| m.len()).unwrap_or(0);

    // last_heartbeat_at: derived from the brain doc's mtime (since the engine
    // overwrites it on every tick that produces output). Falls back to None
    // on a fresh install.
    let last_heartbeat_at: Option<DateTime<Utc>> = std::fs::metadata(&brain_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| chrono::DateTime::<Utc>::from_timestamp(d.as_secs() as i64, 0));

    // next_heartbeat_at: heuristic — last + 5 min foreground cadence. The
    // daemon owns the actual scheduling; this field is just a hint for the UI
    // so users can see "next: 14:28" without an extra IPC round-trip.
    let next_heartbeat_at = last_heartbeat_at.map(|t| t + Duration::from_secs(5 * 60));

    let observations_today = observations::observations_today_count(&root, Utc::now());

    Ok(CoThinkerStatus {
        last_heartbeat_at: last_heartbeat_at.map(|t| t.to_rfc3339()),
        next_heartbeat_at: next_heartbeat_at.map(|t| t.to_rfc3339()),
        brain_doc_size,
        observations_today,
    })
}
