//! v3.5 §5.2 — Enterprise audit log (stub region routing).
//!
//! Append-only, per-day JSONL log of every state-mutating action. Mirrors
//! the existing `agi::telemetry` storage pattern but with stricter
//! immutability:
//!
//!   `~/.tangerine-memory/.tangerine/audit/{YYYY-MM-DD}.jsonl`
//!
//! v3.5 stub mode: every entry is stamped with `region: "us-east"` so the
//! IPC contract is locked. The real region routing (`china` /
//! `us` / `eu`) lights up in the v3.5 enterprise tier once
//! the per-tenant deployment isolation lands per spec §4.2 / §5.3.
//!
//! Append semantics: each event is one JSON object on one line, written via
//! `OpenOptions::new().append(true)`. POSIX `O_APPEND` writes shorter than
//! `PIPE_BUF` are atomic on every platform we ship — same model as
//! `agi::telemetry::append_event`. We do NOT chain HMACs in stub mode; the
//! production cut adds the HMAC chain (§5.2 calls for tamper-evident logs)
//! once the tenant key-management story lands.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// One audit log entry. Field names mirror the TypeScript shape that
/// `app/src/lib/tauri.ts` exports for the React-side admin console. The
/// `payload` field is JSON so the writer never has to be rebuilt for a
/// new action type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEntry {
    /// ISO 8601 timestamp. The writer stamps this on the way in if
    /// `Option::None`.
    pub ts: DateTime<Utc>,
    /// User alias performing the action.
    pub user: String,
    /// Action name. Free-form string — see `V3_5_SPEC.md` §5.2 for the
    /// initial taxonomy (`auth.login`, `brain.write`, `template.install`,
    /// `branding.update`, ...).
    pub action: String,
    /// Resource the action targets (atom id, template id, tenant id, ...).
    pub resource: String,
    /// Optional client IP. Stub mode lets the caller stamp this; real
    /// production reads from the inbound HTTP request.
    pub ip: Option<String>,
    /// Optional User-Agent string.
    pub user_agent: Option<String>,
    /// Region the entry was written in. Stub always writes `"us-east"`.
    /// Real region routing in v3.5 enterprise tier (per spec §5.3) sets
    /// one of `"china"`, `"us-east"`, `"us-west"`, `"eu-west"`.
    pub region: String,
}

/// What the writer accepts. Lets the caller omit `ts` and `region` so the
/// writer can stamp them deterministically — keeps the IPC contract
/// consistent with the production cut.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntryInput {
    pub user: String,
    pub action: String,
    pub resource: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn audit_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join(".tangerine").join("audit");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("audit_mkdir", e.to_string()))?;
    Ok(dir)
}

fn day_file(memory_root: &Path, day: NaiveDate) -> Result<PathBuf, AppError> {
    Ok(audit_dir(memory_root)?.join(format!("{}.jsonl", day)))
}

/// Append one entry for today (UTC). Stub mode stamps `region = "us-east"`.
pub fn append(memory_root: &Path, input: AuditEntryInput) -> Result<AuditEntry, AppError> {
    let now = Utc::now();
    let entry = AuditEntry {
        ts: now,
        user: input.user,
        action: input.action,
        resource: input.resource,
        ip: input.ip,
        user_agent: input.user_agent,
        region: "us-east".to_string(),
    };
    let path = day_file(memory_root, now.date_naive())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("audit_open", e.to_string()))?;
    let mut line = serde_json::to_string(&entry)?;
    line.push('\n');
    file.write_all(line.as_bytes())
        .map_err(|e| AppError::internal("audit_write", e.to_string()))?;
    Ok(entry)
}

/// Read every entry for a given UTC day. Empty file ⇒ empty Vec; missing
/// file ⇒ empty Vec.
pub fn read_day(memory_root: &Path, day: NaiveDate) -> Result<Vec<AuditEntry>, AppError> {
    let path = day_file(memory_root, day)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal("audit_read_day", e.to_string()))?;
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(line) {
            Ok(e) => out.push(e),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    line = %line,
                    "skipping malformed audit entry"
                );
            }
        }
    }
    Ok(out)
}

/// Read every entry from the last `days` UTC days. `days = 0` ⇒ today only.
pub fn read_window(memory_root: &Path, days: u32) -> Result<Vec<AuditEntry>, AppError> {
    let today = Utc::now().date_naive();
    let mut out = Vec::new();
    for n in 0..=days {
        if let Some(d) = today.checked_sub_signed(chrono::Duration::days(n as i64)) {
            out.extend(read_day(memory_root, d)?);
        }
    }
    out.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(out)
}

/// Search across the audit log. Filters by free-text substring on
/// `action` + `resource` + `user` and an optional day window. Empty query
/// returns every entry in-window.
pub fn search(
    memory_root: &Path,
    query: &str,
    days: u32,
) -> Result<Vec<AuditEntry>, AppError> {
    let q = query.to_lowercase();
    let entries = read_window(memory_root, days)?;
    if q.is_empty() {
        return Ok(entries);
    }
    Ok(entries
        .into_iter()
        .filter(|e| {
            e.action.to_lowercase().contains(&q)
                || e.resource.to_lowercase().contains(&q)
                || e.user.to_lowercase().contains(&q)
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-audit-{}", id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn input(action: &str) -> AuditEntryInput {
        AuditEntryInput {
            user: "daizhe".into(),
            action: action.into(),
            resource: "atom-1".into(),
            ip: Some("127.0.0.1".into()),
            user_agent: Some("test-agent/1.0".into()),
        }
    }

    #[test]
    fn append_writes_entry_and_stamps_region() {
        let root = TempDir::new();
        let entry = append(root.path(), input("template.install")).unwrap();
        assert_eq!(entry.region, "us-east");
        assert_eq!(entry.action, "template.install");
        assert_eq!(entry.user, "daizhe");

        let today = Utc::now().date_naive();
        let day = read_day(root.path(), today).unwrap();
        assert_eq!(day.len(), 1);
        assert_eq!(day[0], entry);
    }

    #[test]
    fn append_is_append_only_across_calls() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let _ = append(root.path(), input("brain.write")).unwrap();
        let _ = append(root.path(), input("template.install")).unwrap();

        let today = Utc::now().date_naive();
        let entries = read_day(root.path(), today).unwrap();
        assert_eq!(entries.len(), 3);
        let actions: Vec<&str> = entries.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(actions, vec!["auth.login", "brain.write", "template.install"]);
    }

    #[test]
    fn read_day_returns_empty_when_missing() {
        let root = TempDir::new();
        let day = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
        let entries = read_day(root.path(), day).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn read_window_includes_today() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let entries = read_window(root.path(), 0).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn search_filters_by_action_substring() {
        let root = TempDir::new();
        let _ = append(root.path(), input("auth.login")).unwrap();
        let _ = append(root.path(), input("template.install")).unwrap();
        let _ = append(root.path(), input("brain.write")).unwrap();

        let hits = search(root.path(), "template", 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].action, "template.install");
    }

    #[test]
    fn search_with_empty_query_returns_all() {
        let root = TempDir::new();
        let _ = append(root.path(), input("a")).unwrap();
        let _ = append(root.path(), input("b")).unwrap();
        let hits = search(root.path(), "", 0).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn search_is_case_insensitive() {
        let root = TempDir::new();
        let _ = append(root.path(), input("Auth.Login")).unwrap();
        let hits = search(root.path(), "AUTH", 0).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let root = TempDir::new();
        let _ = append(root.path(), input("first")).unwrap();
        // Inject a malformed line directly.
        let today = Utc::now().date_naive();
        let path = day_file(root.path(), today).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{not valid json").unwrap();
        let _ = append(root.path(), input("second")).unwrap();

        let entries = read_day(root.path(), today).unwrap();
        assert_eq!(entries.len(), 2);
    }
}
