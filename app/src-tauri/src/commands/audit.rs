//! v3.5 §5.2 — Tauri command surface for the audit log.
//!
//! Thin envelope around `crate::audit_log`. Stub mode stamps every entry
//! with `region: "us-east"`; the real region routing
//! (`china` / `us-east` / `us-west` / `eu-west`) lights up
//! once the per-tenant deployment isolation lands per spec §4.2 / §5.3.

use std::path::PathBuf;

use chrono::NaiveDate;

use crate::audit_log::{self, AuditEntry, AuditEntryInput};

use super::AppError;

fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Append one entry to today's audit log file. Stub mode stamps `region`.
#[tauri::command]
pub async fn audit_append(input: AuditEntryInput) -> Result<AuditEntry, AppError> {
    let root = resolve_memory_root()?;
    audit_log::append(&root, input)
}

/// Read every entry from the last `days` UTC days. `days = 0` ⇒ today only.
#[tauri::command]
pub async fn audit_read_window(days: u32) -> Result<Vec<AuditEntry>, AppError> {
    let root = resolve_memory_root()?;
    audit_log::read_window(&root, days)
}

/// Read every entry for a specific UTC day (`YYYY-MM-DD`).
#[tauri::command]
pub async fn audit_read_day(day: String) -> Result<Vec<AuditEntry>, AppError> {
    let root = resolve_memory_root()?;
    let parsed = NaiveDate::parse_from_str(&day, "%Y-%m-%d").map_err(|e| {
        AppError::user(
            "audit_bad_day",
            format!("expected YYYY-MM-DD, got '{}': {}", day, e),
        )
    })?;
    audit_log::read_day(&root, parsed)
}

/// Search the audit log by free-text substring on
/// `action` + `resource` + `user`.
#[tauri::command]
pub async fn audit_search(query: String, days: u32) -> Result<Vec<AuditEntry>, AppError> {
    let root = resolve_memory_root()?;
    audit_log::search(&root, &query, days)
}
