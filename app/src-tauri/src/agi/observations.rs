//! v1.8 Phase 3-B — Observation log (heartbeat audit trail).
//!
//! One file per UTC date under `~/.tangerine-memory/agi/observations/`.
//! Each heartbeat appends a single human-readable line so the user can `cat`
//! today's file and see exactly what the brain did, when, and why.
//!
//! Format (one entry, single line):
//!   `HH:MM:SS cadence=foreground atoms_seen=3 channel=mcp proposals=0 brief="..."`
//!
//! Append is atomic-ish — we open with `OpenOptions::append(true)` rather
//! than the rename-trick because we want concurrent heartbeats (which the
//! throttle prevents anyway) to never lose an entry. The brief text is
//! pre-escaped by the caller (see `co_thinker::escape_for_log`).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::commands::AppError;

/// Resolve the observations file path for the given date.
pub fn observations_path(memory_root: &Path, ts: DateTime<Utc>) -> PathBuf {
    memory_root
        .join("agi")
        .join("observations")
        .join(format!("{}.md", ts.format("%Y-%m-%d")))
}

/// Append one heartbeat-summary line to today's observations file.
/// Creates the parent dir + the file's H1 header on first write.
pub fn append_observation(
    memory_root: &Path,
    ts: DateTime<Utc>,
    body: &str,
) -> Result<(), AppError> {
    let path = observations_path(memory_root, ts);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_observations", e.to_string()))?;
    }

    let needs_header = !path.exists();

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("open_observations", e.to_string()))?;

    if needs_header {
        let header = format!(
            "# Co-thinker observations — {}\n\n",
            ts.format("%Y-%m-%d")
        );
        f.write_all(header.as_bytes())
            .map_err(|e| AppError::internal("write_observations_header", e.to_string()))?;
    }

    let line = if body.ends_with('\n') {
        body.to_string()
    } else {
        format!("{}\n", body)
    };
    f.write_all(line.as_bytes())
        .map_err(|e| AppError::internal("write_observations", e.to_string()))?;
    Ok(())
}

/// Phase 4 stub — daily 3 AM compaction task condenses observations older
/// than `before_date` into a one-paragraph "rolled up" summary so the
/// observations dir doesn't grow forever. For Phase 3 this is a no-op so
/// the call site exists; the implementation lands in Phase 4.
pub fn compact_old(_memory_root: &Path, _before_date: chrono::NaiveDate) -> Result<u32, AppError> {
    // Intentional Phase 4 stub. Returns 0 entries-compacted for now.
    Ok(0)
}

/// Count today's observations entries (excluding the H1 header). Used by the
/// /co-thinker route's status panel.
pub fn observations_today_count(memory_root: &Path, now: DateTime<Utc>) -> u32 {
    let path = observations_path(memory_root, now);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    raw.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_obs_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn append_creates_file_with_header() {
        let root = tmp_root();
        let now = Utc::now();
        append_observation(&root, now, "first entry").unwrap();
        let path = observations_path(&root, now);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("# Co-thinker observations"));
        assert!(raw.contains("first entry"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_does_not_duplicate_header() {
        let root = tmp_root();
        let now = Utc::now();
        append_observation(&root, now, "one").unwrap();
        append_observation(&root, now, "two").unwrap();
        let raw = std::fs::read_to_string(observations_path(&root, now)).unwrap();
        let header_count = raw.matches("# Co-thinker observations").count();
        assert_eq!(header_count, 1);
        assert!(raw.contains("one"));
        assert!(raw.contains("two"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn count_today_excludes_header() {
        let root = tmp_root();
        let now = Utc::now();
        append_observation(&root, now, "a").unwrap();
        append_observation(&root, now, "b").unwrap();
        assert_eq!(observations_today_count(&root, now), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn count_today_returns_zero_when_missing() {
        let root = tmp_root();
        let now = Utc::now();
        assert_eq!(observations_today_count(&root, now), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn compact_old_is_phase4_stub() {
        let root = tmp_root();
        let n = compact_old(&root, chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()).unwrap();
        assert_eq!(n, 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
