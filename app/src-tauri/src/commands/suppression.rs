//! Perf (API_SURFACE_SPEC §5): `suppression_check` / `suppression_list` are
//! read commands → 50 ms p95 (in-memory map). `suppression_clear` /
//! `suppression_recompute` are write commands → 200 ms p95.
//!
//! v1.9.0-beta.3 P3-A — Suppression Tauri command surface.
//!
//! Thin envelope around `crate::agi::suppression`. The frontend's
//! `pushSuggestion(req)` (in `lib/suggestion-bus.ts`) calls
//! `suppression_check` before dispatching to drop suggestions whose
//! `{template, scope}` pair has been dismissed 3+ times in the last 30
//! days. The AGI Settings page reads `suppression_list` to surface the
//! currently-suppressed list and offers a `suppression_clear` admin
//! reset button.
//!
//! `suppression_recompute` is the same pass the daemon runs each
//! heartbeat — exposed as a Tauri command so the Settings page can
//! force a refresh out-of-band (e.g. right after the user clears the
//! list, the next refresh re-tallies from the telemetry log).

use std::path::PathBuf;

use chrono::Utc;

use crate::agi::suppression::{self, SuppressionEntry};

use super::AppError;

/// Resolve the user's memory root. Mirrors
/// `commands::telemetry::resolve_memory_root` — duplicated locally so
/// this module doesn't take a private dep on memory.rs internals.
fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Returns `true` when `{template, scope}` is currently suppressed.
/// Reads the on-disk db each call — the daemon refreshes the file on
/// every heartbeat so this stays current within the heartbeat cadence.
/// A missing / unreadable db reads as "not suppressed" so a fresh
/// install never gates suggestions on missing state.
#[tauri::command]
pub async fn suppression_check(template: String, scope: String) -> Result<bool, AppError> {
    let root = resolve_memory_root()?;
    let db = suppression::read_suppression_db(&root).await?;
    Ok(suppression::is_suppressed(&db, &template, &scope, Utc::now()))
}

/// Recompute the suppression map from the last 30 days of telemetry,
/// write it to disk, and return the count of currently-suppressed
/// entries. Called by the daemon every heartbeat; also exposed as a
/// command so Settings can force a refresh after a manual clear.
#[tauri::command]
pub async fn suppression_recompute() -> Result<u32, AppError> {
    let root = resolve_memory_root()?;
    let db = suppression::recompute_from_telemetry(&root).await?;
    suppression::write_suppression_db(&root, &db).await?;
    let now = Utc::now();
    let count = db
        .values()
        .filter(|e| match e.suppressed_until {
            Some(until) => now < until,
            None => false,
        })
        .count() as u32;
    Ok(count)
}

/// Wipe the suppression file. Backs the "Clear suppression list" button
/// in AGI Settings. The very next daemon recompute will re-derive
/// counts from telemetry — so a user who has dismissed an active
/// pattern many times will see the suppression re-promote unless they
/// also clear telemetry. That's intentional: suppression is the layer
/// the user controls, telemetry is the layer that derives it.
#[tauri::command]
pub async fn suppression_clear() -> Result<(), AppError> {
    let root = resolve_memory_root()?;
    suppression::clear_suppression(&root).await
}

/// Return every entry in the suppression db. Used by the AGI Settings
/// "Suppressed suggestions" section. Returns an empty vec on a fresh
/// install (no file). Order is undefined — the UI sorts client-side.
#[tauri::command]
pub async fn suppression_list() -> Result<Vec<SuppressionEntry>, AppError> {
    let root = resolve_memory_root()?;
    let db = suppression::read_suppression_db(&root).await?;
    Ok(db.into_values().collect())
}
