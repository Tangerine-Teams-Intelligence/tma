//! v1.9.0-beta.1 P1-A — Action telemetry Tauri command surface.
//!
//! Thin envelope around `crate::agi::telemetry`. The frontend wrapper at
//! `app/src/lib/telemetry.ts::logEvent` calls `telemetry_log` once per
//! observed UI action; the suggestion engine (v1.9.0-beta.2) calls
//! `telemetry_read_window` to feed pattern detectors. Pattern detection
//! itself lives in the v1.9.0-beta.2 sibling — this module only writes +
//! reads.

use std::path::{Path, PathBuf};

use crate::agi::telemetry::{self, TelemetryEvent};

use super::AppError;

/// Resolve the user's memory root. Mirrors `commands::memory::memory_root`
/// — duplicated locally so this module doesn't take a private dep on
/// memory.rs internals (and so testing this command surface doesn't pull
/// the entire memory layer in).
fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Append one telemetry event to today's JSONL file. Frontend stamps the
/// `ts` and `user` fields; the backend trusts them — telemetry is local
/// observational data, not a security boundary.
#[tauri::command]
pub async fn telemetry_log(event: TelemetryEvent) -> Result<(), AppError> {
    let root = resolve_memory_root()?;
    telemetry::append_event(&root, event).await
}

/// Read every event whose timestamp falls within the last `hours` hours.
/// Walks today's file plus prior days as needed. Returns an empty vec when
/// no telemetry has been recorded yet.
#[tauri::command]
pub async fn telemetry_read_window(hours: u32) -> Result<Vec<TelemetryEvent>, AppError> {
    let root = resolve_memory_root()?;
    telemetry::read_events_window(&root, hours).await
}

/// Wipe every telemetry file. Backs the "Clear telemetry" button in the
/// AGI Settings tab. Returns the number of files removed so the UI can
/// confirm the operation in a toast.
#[tauri::command]
pub async fn telemetry_clear() -> Result<u32, AppError> {
    let root = resolve_memory_root()?;
    let count = telemetry::clear_all(&root)?;
    Ok(count)
}

/// Hook called once at app boot to delete telemetry files older than the
/// 90-day retention window. Exposed as a function (not a Tauri command) so
/// `main.rs` / the daemon can invoke it directly without going through the
/// IPC layer. Errors are swallowed by the caller — pruning is best-effort.
#[allow(dead_code)]
pub fn prune_old_on_boot(memory_root: &Path) -> u32 {
    telemetry::prune_old(memory_root).unwrap_or(0)
}
