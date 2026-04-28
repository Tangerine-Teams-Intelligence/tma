//! Perf (API_SURFACE_SPEC §5): `co_thinker_read_brain` / `co_thinker_status`
//! are read commands → 50 ms p95. `co_thinker_write_brain` is a write command
//! → 200 ms p95. `co_thinker_trigger_heartbeat` is the heartbeat bucket →
//! 30 s p95 (the entire ambient ingest + brain rewrite cycle).
//!
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

use crate::agi::co_thinker::{
    seed_brain_doc, CoThinkerEngine, HeartbeatCadence, HeartbeatOutcome,
};
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
pub async fn co_thinker_write_brain<R: Runtime>(
    app: AppHandle<R>,
    content: String,
) -> Result<(), AppError> {
    let root = memory_root()?;
    let mut engine = CoThinkerEngine::new(root);
    // === wave 16 ===
    // Install the Tauri activity sink so a manual brain edit also surfaces
    // on the right-rail feed (the user clicked Save, that's a real event).
    engine.set_activity_sink(Arc::new(crate::activity::TauriActivitySink::new(app)));
    // === end wave 16 ===
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
    engine.set_event_sink(Arc::new(TauriEventSink::new(app.clone())));
    // === wave 16 ===
    // Install the TauriActivitySink so brain-doc writes from the
    // heartbeat surface as `activity:atom_written` events on the React
    // side. The default RingOnly sink is replaced; the daemon-driven
    // path keeps RingOnly so the ring populates without needing an
    // AppHandle.
    engine.set_activity_sink(Arc::new(crate::activity::TauriActivitySink::new(
        app,
    )));
    // === end wave 16 ===
    engine
        .heartbeat(HeartbeatCadence::Manual, primary_tool_id)
        .await
}

/// === wave 6 === BUG #2 — Initialize the brain doc to the cold-start seed
/// template so the file exists on disk immediately after the user clicks
/// "Initialize co-thinker brain" — even if the subsequent heartbeat can't
/// reach an LLM channel.
///
/// Idempotent: if the brain doc already exists (with non-trivial content),
/// this is a no-op so we don't clobber a hand-edit. After the seed lands,
/// we still try to fire one heartbeat — failure there is fine; the user has
/// a real, on-disk brain doc they can `cat`/`edit` regardless.
///
/// Returns the heartbeat outcome (the seed-write itself is implicit). The
/// frontend uses the `error` field to show a friendly explanation when the
/// LLM is unreachable; the user's brain doc is on disk either way.
#[tauri::command]
pub async fn co_thinker_initialize_brain<R: Runtime>(
    app: AppHandle<R>,
    primary_tool_id: Option<String>,
) -> Result<HeartbeatOutcome, AppError> {
    let root = memory_root()?;
    let mut engine = CoThinkerEngine::new(root);
    // === wave 16 ===
    // Install the activity sink BEFORE the seed-write below so that
    // first-run users see the brain seed event surface in their right-
    // rail feed immediately (otherwise the seed lands silently on the
    // RingOnly default).
    engine.set_activity_sink(Arc::new(crate::activity::TauriActivitySink::new(
        app.clone(),
    )));
    // === end wave 16 ===

    // Step 1 — ensure the seed is on disk. If the user already has a brain
    // doc with real content, skip; otherwise (missing, or just the seed
    // template echo) write the seed.
    let brain_path = engine.brain_doc_path();
    let needs_seed = match std::fs::read_to_string(&brain_path) {
        Ok(s) => s.trim().is_empty(),
        Err(_) => true,
    };
    if needs_seed {
        engine.write_brain_doc(&seed_brain_doc(Utc::now()))?;
    }

    // Step 2 — fire one heartbeat. If the LLM is unreachable the seed stays
    // on disk and the outcome carries the dispatch error for the frontend
    // to surface.
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
    // === wave 6 === BUG #1 — brain doc moved from `agi/` to `team/`. We
    // still fall back to reading from the legacy path's metadata if a v1.9.2
    // install hasn't triggered a heartbeat yet (so the new path doesn't
    // exist) but the legacy doc does — so the status strip shows the real
    // last-write time instead of "never".
    let brain_path = root.join("team").join("co-thinker.md");
    let legacy_brain_path = root.join("agi").join("co-thinker.md");
    let metadata_source = if brain_path.exists() {
        brain_path.clone()
    } else {
        legacy_brain_path
    };
    let brain_doc_size = std::fs::metadata(&metadata_source)
        .map(|m| m.len())
        .unwrap_or(0);

    // last_heartbeat_at: derived from the brain doc's mtime (since the engine
    // overwrites it on every tick that produces output). Falls back to None
    // on a fresh install.
    let last_heartbeat_at: Option<DateTime<Utc>> = std::fs::metadata(&metadata_source)
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
