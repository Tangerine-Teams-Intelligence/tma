//! Perf (API_SURFACE_SPEC §5): `audit_append` is a write command → 200 ms p95
//! (append-only JSONL). `audit_read_*` / `audit_search` / `audit_log_export`
//! / `audit_get_region` / `audit_verify_chain` are read commands → 50 ms p95
//! for typical day windows; longer ranges scale linearly. `audit_set_region`
//! is a write command → 200 ms p95.
//!
//! v3.5 §5.2 — Tauri command surface for the audit log.
//!
//! Thin envelope around `crate::audit_log`. v3.5 wave 2 adds:
//!   * `audit_log_export` — SOC 2 audit-evidence pull over a date range
//!   * `audit_get_region` / `audit_set_region` — daemon-local region pref
//!   * `audit_verify_chain` — tamper-detection re-verify endpoint
//!
//! The chain-detection endpoint exists so the React-side admin console can
//! show an "audit log integrity: OK / N entries tampered" indicator on the
//! enterprise admin view without forcing the auditor to drop to a CLI.

use std::path::PathBuf;

use chrono::NaiveDate;

use crate::audit_log::{self, AuditEntry, AuditEntryInput};

use super::AppError;

fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

fn parse_day(label: &str, raw: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|e| {
        AppError::user(
            "audit_bad_day",
            format!("{} expected YYYY-MM-DD, got '{}': {}", label, raw, e),
        )
    })
}

/// Append one entry to today's audit log file. Stamps `region` from
/// `region.txt` (default `us-east`) and an HMAC-SHA-256 chain hash.
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
    let parsed = parse_day("day", &day)?;
    audit_log::read_day(&root, parsed)
}

/// Search the audit log by free-text substring on
/// `action` + `resource` + `user`.
#[tauri::command]
pub async fn audit_search(query: String, days: u32) -> Result<Vec<AuditEntry>, AppError> {
    let root = resolve_memory_root()?;
    audit_log::search(&root, &query, days)
}

/// SOC 2 export — return every entry between `start` and `end` (UTC dates,
/// inclusive). The auditor verifies the HMAC chain offline by feeding the
/// returned slice to `audit_verify_chain` (or running the same algorithm
/// against the daemon's `audit_secret` they exported separately under NDA).
#[tauri::command]
pub async fn audit_log_export(
    start: String,
    end: String,
) -> Result<Vec<AuditEntry>, AppError> {
    let root = resolve_memory_root()?;
    let s = parse_day("start", &start)?;
    let e = parse_day("end", &end)?;
    audit_log::export_window(&root, s, e)
}

/// Re-verify the HMAC chain over a slice of entries. Returns the index of
/// the first tampered entry, or `None` when the slice is intact. `prev_chain`
/// is the chain hash immediately preceding the slice (empty string for the
/// start of a day).
#[tauri::command]
pub async fn audit_verify_chain(
    entries: Vec<AuditEntry>,
    prev_chain: String,
) -> Result<Option<usize>, AppError> {
    let root = resolve_memory_root()?;
    audit_log::verify_chain(&root, &entries, &prev_chain)
}

/// Read the daemon's configured region. Defaults to `"us-east"` when
/// `region.txt` is missing or empty. Never errors.
#[tauri::command]
pub async fn audit_get_region() -> Result<String, AppError> {
    let root = resolve_memory_root()?;
    Ok(audit_log::read_region(&root))
}

/// Persist a new region preference. Returns the canonical region string the
/// daemon will use going forward. Invalid values are rejected with a
/// `User`-tagged error.
#[tauri::command]
pub async fn audit_set_region(region: String) -> Result<String, AppError> {
    let root = resolve_memory_root()?;
    audit_log::write_region(&root, &region)
}
