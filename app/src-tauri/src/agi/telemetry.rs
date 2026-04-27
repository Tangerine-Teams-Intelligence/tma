//! v1.9.0-beta.1 P1-A — Action telemetry writer.
//!
//! Append-only JSONL log of every meaningful user action so the v1.9.0-beta.2
//! suggestion engine can later reason about patterns (Pattern recurrence,
//! Stale RFC, etc.). This module is the inert filesystem layer — it knows
//! nothing about pattern detection, ranking, or suggestion templates.
//!
//! Storage:
//!   `~/.tangerine-memory/.tangerine/telemetry/{YYYY-MM-DD}.jsonl`
//!
//! One JSON object per line, append-only via
//! `OpenOptions::new().append(true)`. We deliberately use the same
//! "concurrent appends are atomic-ish" model as `agi::observations` — POSIX
//! `O_APPEND` writes shorter than `PIPE_BUF` are atomic on every platform we
//! ship (Linux/macOS/Windows NTFS), which covers a single-line JSON object
//! well under the 4 KiB threshold.
//!
//! Privacy: telemetry is local-only. Cloud-sync is a future v1.9 opt-in flag
//! per `SUGGESTION_ENGINE_SPEC.md` §2.3. Retention is 90 days; the
//! `prune_old` helper runs once at app start to delete dated files older
//! than the cutoff.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// One telemetry entry. Shape matches `app/src/lib/telemetry.ts::TelemetryEvent`
/// — both sides serialize/deserialize the same JSON.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TelemetryEvent {
    /// Event name. See `TelemetryEventName` in the frontend for the closed
    /// set of valid values; we accept any string here so the writer never
    /// rejects a future event the frontend has but the backend hasn't been
    /// rebuilt to know about.
    pub event: String,
    /// ISO 8601 timestamp. Frontend stamps this; backend just records it.
    pub ts: String,
    /// Resolved current user (`ui.currentUser` from the React store).
    pub user: String,
    /// Event-specific schema. JSON value so the writer is fully event-agnostic.
    pub payload: serde_json::Value,
}

/// 90 days of telemetry retention. Matches `SUGGESTION_ENGINE_SPEC.md` §2.1
/// for the longest-retained event class.
const RETENTION_DAYS: i64 = 90;

/// Directory under the memory root where telemetry JSONL files live.
fn telemetry_dir(memory_root: &Path) -> PathBuf {
    memory_root.join(".tangerine").join("telemetry")
}

/// Path to the JSONL file for a given UTC date.
fn telemetry_path(memory_root: &Path, ts: DateTime<Utc>) -> PathBuf {
    telemetry_dir(memory_root).join(format!("{}.jsonl", ts.format("%Y-%m-%d")))
}

/// Append a single event to today's JSONL file. Creates the parent dir on
/// first call. Each event is one line of compact JSON terminated by `\n`.
pub async fn append_event(memory_root: &Path, event: TelemetryEvent) -> Result<(), AppError> {
    let path = telemetry_path(memory_root, Utc::now());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_telemetry", e.to_string()))?;
    }

    let line = serde_json::to_string(&event)
        .map_err(|e| AppError::internal("serialize_telemetry", e.to_string()))?;

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("open_telemetry", e.to_string()))?;

    // Single write of `<line>\n` so the kernel's atomic-append guarantee
    // covers the whole record. Two separate writes would let a concurrent
    // appender interleave between them.
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    f.write_all(&buf)
        .map_err(|e| AppError::internal("write_telemetry", e.to_string()))?;
    Ok(())
}

/// Read every event in today's JSONL file (UTC). Returns an empty vec when
/// the file doesn't exist. Malformed lines are skipped silently — we never
/// surface a parse error to the caller because telemetry is observational
/// and a single bad line shouldn't break the entire window read.
pub async fn read_events_today(memory_root: &Path) -> Result<Vec<TelemetryEvent>, AppError> {
    let path = telemetry_path(memory_root, Utc::now());
    Ok(read_file(&path))
}

/// Read every event whose `ts` falls within the last `hours` hours from
/// now. Walks today's file plus yesterday's when the window straddles UTC
/// midnight; older windows pull additional files as needed.
pub async fn read_events_window(
    memory_root: &Path,
    hours: u32,
) -> Result<Vec<TelemetryEvent>, AppError> {
    let now = Utc::now();
    let cutoff = now - Duration::hours(hours as i64);

    // Walk back day-by-day until the cutoff is older than the start of that
    // day, so we cover any window length up to RETENTION_DAYS.
    let mut events: Vec<TelemetryEvent> = Vec::new();
    let mut cursor_date = now.date_naive();
    let cutoff_date = cutoff.date_naive();
    loop {
        let path = telemetry_dir(memory_root).join(format!("{}.jsonl", cursor_date));
        for ev in read_file(&path) {
            // Parse the event's ts; drop entries older than cutoff. Entries
            // with malformed timestamps are kept (defensive — if the writer
            // ever emits a non-ISO string, we'd rather show it than swallow).
            if let Ok(parsed) = DateTime::parse_from_rfc3339(&ev.ts) {
                if parsed.with_timezone(&Utc) < cutoff {
                    continue;
                }
            }
            events.push(ev);
        }
        if cursor_date <= cutoff_date {
            break;
        }
        cursor_date = match cursor_date.pred_opt() {
            Some(d) => d,
            None => break,
        };
    }
    Ok(events)
}

/// Delete telemetry files older than `RETENTION_DAYS`. Called once at app
/// boot. Returns the number of files deleted; a soft-fail on individual
/// `remove_file` errors is fine because the next boot will retry.
pub fn prune_old(memory_root: &Path) -> Result<u32, AppError> {
    let dir = telemetry_dir(memory_root);
    if !dir.is_dir() {
        return Ok(0);
    }
    let cutoff_date = (Utc::now() - Duration::days(RETENTION_DAYS)).date_naive();
    let mut deleted = 0u32;
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        let date = match NaiveDate::parse_from_str(stem, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };
        if date < cutoff_date {
            if std::fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }
    Ok(deleted)
}

/// Wipe every telemetry file. Backs the "Clear telemetry" button in the
/// AGI Settings tab. Returns the number of files removed.
pub fn clear_all(memory_root: &Path) -> Result<u32, AppError> {
    let dir = telemetry_dir(memory_root);
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut deleted = 0u32;
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Read one JSONL file, skipping malformed lines. Returns an empty vec when
/// the file doesn't exist or is unreadable (telemetry is observational —
/// we never want a missing file to error the read path).
fn read_file(path: &Path) -> Vec<TelemetryEvent> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<TelemetryEvent>(trimmed).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_telemetry_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_event(name: &str, ts: DateTime<Utc>) -> TelemetryEvent {
        TelemetryEvent {
            event: name.to_string(),
            ts: ts.to_rfc3339(),
            user: "daizhe".to_string(),
            payload: serde_json::json!({ "test": true }),
        }
    }

    #[tokio::test]
    async fn test_append_event_creates_jsonl_file() {
        let root = tmp_root();
        let event = make_event("navigate_route", Utc::now());
        append_event(&root, event.clone()).await.unwrap();

        let path = telemetry_path(&root, Utc::now());
        assert!(path.is_file(), "jsonl file must exist after append");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.ends_with('\n'), "each entry ends with newline");
        let parsed: TelemetryEvent =
            serde_json::from_str(content.trim()).expect("line is valid json");
        assert_eq!(parsed.event, "navigate_route");
        assert_eq!(parsed.user, "daizhe");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_read_window_returns_recent_only() {
        let root = tmp_root();

        // Recent event (5 minutes ago) — should be in 24h window.
        let recent = make_event("navigate_route", Utc::now() - Duration::minutes(5));
        append_event(&root, recent).await.unwrap();

        // Old event (25 hours ago) — should NOT be in 24h window. We write
        // it directly to yesterday's file so the date-walking logic also
        // sees it before the time filter rejects it.
        let old_ts = Utc::now() - Duration::hours(25);
        let old_event = make_event("dismiss_chip", old_ts);
        let old_path = telemetry_path(&root, old_ts);
        std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
        let line = serde_json::to_string(&old_event).unwrap();
        std::fs::write(&old_path, format!("{}\n", line)).unwrap();

        let events = read_events_window(&root, 24).await.unwrap();

        assert_eq!(events.len(), 1, "only the recent event survives the 24h window");
        assert_eq!(events[0].event, "navigate_route");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_concurrent_appends_no_corruption() {
        let root = tmp_root();
        let mut handles = Vec::new();
        // Spawn 10 parallel appends. Single-line JSON well under PIPE_BUF
        // means O_APPEND keeps each line atomic on every platform we ship.
        for i in 0..10u32 {
            let r = root.clone();
            handles.push(tokio::spawn(async move {
                let ev = TelemetryEvent {
                    event: format!("evt_{}", i),
                    ts: Utc::now().to_rfc3339(),
                    user: "daizhe".to_string(),
                    payload: serde_json::json!({ "i": i }),
                };
                append_event(&r, ev).await.unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let path = telemetry_path(&root, Utc::now());
        let raw = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 10, "all 10 lines present, no corruption");
        for line in &lines {
            let parsed: TelemetryEvent =
                serde_json::from_str(line).expect("each line parses cleanly");
            assert!(parsed.event.starts_with("evt_"));
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_prune_old_deletes_stale_files() {
        let root = tmp_root();
        let dir = telemetry_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();

        // Create a file dated 100 days ago and one dated today.
        let old_date = (Utc::now() - Duration::days(100)).date_naive();
        let old_path = dir.join(format!("{}.jsonl", old_date));
        std::fs::write(&old_path, "{}\n").unwrap();
        let today_path = dir.join(format!("{}.jsonl", Utc::now().date_naive()));
        std::fs::write(&today_path, "{}\n").unwrap();

        let n = prune_old(&root).unwrap();
        assert_eq!(n, 1);
        assert!(!old_path.exists(), "100-day-old file removed");
        assert!(today_path.exists(), "today's file kept");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_clear_all_removes_every_jsonl() {
        let root = tmp_root();
        let dir = telemetry_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();

        for d in 0..3i64 {
            let date = (Utc::now() - Duration::days(d)).date_naive();
            let path = dir.join(format!("{}.jsonl", date));
            std::fs::write(&path, "{}\n").unwrap();
        }

        let n = clear_all(&root).unwrap();
        assert_eq!(n, 3);

        let _ = std::fs::remove_dir_all(&root);
    }
}
