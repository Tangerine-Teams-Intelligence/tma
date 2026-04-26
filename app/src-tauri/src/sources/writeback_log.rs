//! Writeback dedup log.
//!
//! Stored at `~/.tangerine-memory/.tangerine/writeback-log.json` (sibling
//! file alongside the existing `timeline.json` / `sources/*.json`). Format:
//!
//! ```json
//! {
//!   "version": 1,
//!   "entries": [
//!     {
//!       "decision_path": "decisions/sample-postgres-over-mongo.md",
//!       "source": "github",
//!       "external_id": "https://github.com/...",
//!       "outcome": { "status": "posted", "external_url": "...", "kind": "github_pull_comment" },
//!       "ts": "2026-04-26T17:30:00Z"
//!     }
//!   ]
//! }
//! ```
//!
//! The watcher writes entries when a writeback completes (success OR a
//! terminal soft-skip). On the next event for the same `decision_path` we
//! find the prior entry, return `AlreadyDone` (when the prior was Posted),
//! and skip the HTTP roundtrip. `Failed` entries are NOT marked terminal,
//! so the watcher will retry on the next file modification — but the entry
//! does record the most recent error so the UI can show it.
//!
//! Concurrency note: writes are atomic (write-tmp + rename). Multiple
//! watchers in the same process serialise via the `WritebackLog` mutex; we
//! don't try to coordinate with external processes touching the file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::WritebackOutcome;
use crate::commands::AppError;

const MAX_ENTRIES_BEFORE_TRUNCATE: usize = 1000;
const TRUNCATE_TARGET: usize = 800;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritebackLogEntry {
    /// Path relative to the memory root (e.g. `decisions/sample-foo.md`).
    pub decision_path: String,
    pub source: String,
    pub external_id: String,
    pub outcome: WritebackOutcome,
    pub ts: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WritebackLogFile {
    pub version: u32,
    pub entries: Vec<WritebackLogEntry>,
}

impl WritebackLogFile {
    fn ensure_versioned(mut self) -> Self {
        if self.version == 0 {
            self.version = 1;
        }
        self
    }
}

/// Process-wide mutex around the on-disk log. Cheap to call repeatedly —
/// every `record` reads + writes the whole file. The file stays under
/// MAX_ENTRIES_BEFORE_TRUNCATE so JSON serde is fine.
pub struct WritebackLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl WritebackLog {
    /// Construct a log handle. `memory_root` is the root the rest of
    /// Tangerine considers canonical (typically `~/.tangerine-memory`).
    pub fn new(memory_root: &Path) -> Self {
        let path = memory_root
            .join(".tangerine")
            .join("writeback-log.json");
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<WritebackLogFile, AppError> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => {
                let parsed: WritebackLogFile = serde_json::from_str(&s).map_err(|e| {
                    AppError::internal(
                        "writeback_log_parse",
                        format!("{}: {}", self.path.display(), e),
                    )
                })?;
                Ok(parsed.ensure_versioned())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(WritebackLogFile::default().ensure_versioned())
            }
            Err(e) => Err(AppError::internal(
                "writeback_log_read",
                format!("{}: {}", self.path.display(), e),
            )),
        }
    }

    fn write(&self, file: &WritebackLogFile) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::internal(
                    "writeback_log_mkdir",
                    format!("{}: {}", parent.display(), e),
                )
            })?;
        }
        let serialised = serde_json::to_string_pretty(file).map_err(|e| {
            AppError::internal("writeback_log_encode", e.to_string())
        })?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serialised).map_err(|e| {
            AppError::internal(
                "writeback_log_tmp_write",
                format!("{}: {}", tmp.display(), e),
            )
        })?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            AppError::internal(
                "writeback_log_rename",
                format!("{}: {}", self.path.display(), e),
            )
        })?;
        Ok(())
    }

    /// Returns the most recent entry for `decision_path` if one exists.
    /// Used by the watcher to short-circuit before the HTTP call.
    pub fn lookup(&self, decision_path: &str) -> Result<Option<WritebackLogEntry>, AppError> {
        let _g = self.lock.lock().expect("writeback log mutex poisoned");
        let log = self.read()?;
        Ok(log
            .entries
            .iter()
            .rev()
            .find(|e| e.decision_path == decision_path)
            .cloned())
    }

    /// Records a fresh outcome. Truncates the head of the log when it
    /// exceeds MAX_ENTRIES_BEFORE_TRUNCATE so the file never grows
    /// without bound — we keep the most recent TRUNCATE_TARGET entries.
    pub fn record(
        &self,
        decision_path: &str,
        source: &str,
        external_id: &str,
        outcome: &WritebackOutcome,
    ) -> Result<(), AppError> {
        let _g = self.lock.lock().expect("writeback log mutex poisoned");
        let mut log = self.read()?;
        log.entries.push(WritebackLogEntry {
            decision_path: decision_path.to_string(),
            source: source.to_string(),
            external_id: external_id.to_string(),
            outcome: outcome.clone(),
            ts: Utc::now(),
        });
        if log.entries.len() > MAX_ENTRIES_BEFORE_TRUNCATE {
            let drop = log.entries.len() - TRUNCATE_TARGET;
            log.entries.drain(0..drop);
        }
        self.write(&log)
    }

    /// Read all entries (most-recent last). Used by the
    /// `read_writeback_log` Tauri command.
    pub fn entries(&self) -> Result<Vec<WritebackLogEntry>, AppError> {
        let _g = self.lock.lock().expect("writeback log mutex poisoned");
        Ok(self.read()?.entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_log() -> (tempfile_minimal::TempDir, WritebackLog) {
        let dir = tempfile_minimal::TempDir::new("ti-wb-log");
        let log = WritebackLog::new(dir.path());
        (dir, log)
    }

    #[test]
    fn empty_lookup_returns_none() {
        let (_d, log) = fresh_log();
        assert!(log.lookup("decisions/foo.md").unwrap().is_none());
    }

    #[test]
    fn record_then_lookup_finds_entry() {
        let (_d, log) = fresh_log();
        let outcome = WritebackOutcome::Posted {
            external_url: "https://example".into(),
            kind: "github_pull_comment".into(),
        };
        log.record("decisions/foo.md", "github", "url", &outcome)
            .unwrap();
        let found = log.lookup("decisions/foo.md").unwrap().unwrap();
        assert_eq!(found.source, "github");
        assert_eq!(found.outcome, outcome);
    }

    #[test]
    fn test_writeback_log_dedup() {
        // Spec contract: calling writeback twice on the same atom should
        // surface AlreadyDone semantics. The watcher consults `lookup` and,
        // when a Posted entry exists, returns AlreadyDone. We verify that
        // here by inspecting the recorded entry directly.
        let (_d, log) = fresh_log();
        let posted = WritebackOutcome::Posted {
            external_url: "https://github.com/foo/bar/pull/1#c-123".into(),
            kind: "github_pull_comment".into(),
        };
        log.record("decisions/dup.md", "github", "https://github.com/foo/bar/pull/1", &posted)
            .unwrap();
        // Second attempt: the watcher should see the prior Posted and decide
        // to short-circuit.
        let prior = log.lookup("decisions/dup.md").unwrap().unwrap();
        assert!(matches!(prior.outcome, WritebackOutcome::Posted { .. }));
        assert_eq!(prior.decision_path, "decisions/dup.md");
        // is_terminal == true for Posted → watcher returns AlreadyDone.
        assert!(prior.outcome.is_terminal());
    }

    #[test]
    fn entries_returns_all_in_chrono_order() {
        let (_d, log) = fresh_log();
        log.record(
            "decisions/a.md",
            "github",
            "x",
            &WritebackOutcome::NotApplicable { reason: "x".into() },
        )
        .unwrap();
        log.record(
            "decisions/b.md",
            "linear",
            "ENG-1",
            &WritebackOutcome::Posted {
                external_url: "https://linear/issue".into(),
                kind: "linear_issue".into(),
            },
        )
        .unwrap();
        let all = log.entries().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].decision_path, "decisions/a.md");
        assert_eq!(all[1].decision_path, "decisions/b.md");
    }

    #[test]
    fn failed_entry_is_not_terminal() {
        let outcome = WritebackOutcome::Failed {
            error: "boom".into(),
        };
        assert!(!outcome.is_terminal());
    }

    // Tiny tempdir helper local to this module.
    mod tempfile_minimal {
        use std::path::{Path, PathBuf};
        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new(prefix: &str) -> Self {
                let dir = std::env::temp_dir()
                    .join(format!("{}-{}", prefix, uuid::Uuid::new_v4().simple()));
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
