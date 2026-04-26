//! `notify`-based watcher over `~/.tangerine-memory/decisions/*.md`.
//!
//! On every create/modify event we:
//!   1. Read the file's frontmatter.
//!   2. Skip if `source` isn't `github` / `linear`.
//!   3. Look up the `writeback-log.json` for a prior terminal entry. If
//!      found and the outcome was Posted, return `AlreadyDone` without
//!      hitting the network.
//!   4. Otherwise call the source-specific `writeback_decision()` and
//!      record the outcome.
//!
//! We deliberately do NOT hook into the existing `watch_meeting`
//! debouncer (in `commands/fs.rs`) — that watcher is per-meeting under
//! `meetings/<id>/`, while this watcher is repo-root-relative and
//! permanent. They watch different subtrees with different lifetimes.
//!
//! Lifecycle: started by `commands::writeback::start_writeback_watcher`
//! when the user toggles either source's writeback ON. Shut down on
//! Drop of the returned `WritebackWatcherHandle` (which lives in
//! `AppState`). Idempotent — calling start while already running just
//! returns the existing handle.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

use super::writeback_log::WritebackLog;
use super::{github, linear, parse_decision_frontmatter, WritebackOutcome};
use crate::commands::AppError;

const DEBOUNCE: Duration = Duration::from_millis(500);

/// Handle returned by `start`. Drop to stop the watcher thread.
pub struct WritebackWatcherHandle {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
}

impl Drop for WritebackWatcherHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Slot that lives in `AppState`. None when no watcher is running.
#[derive(Default)]
pub struct WritebackWatcherSlot(pub Mutex<Option<Arc<WritebackWatcherHandle>>>);

impl WritebackWatcherSlot {
    pub fn install(&self, h: Arc<WritebackWatcherHandle>) {
        *self.0.lock() = Some(h);
    }
    pub fn is_running(&self) -> bool {
        self.0.lock().is_some()
    }
    pub fn stop(&self) {
        *self.0.lock() = None;
    }
}

/// Configuration captured at start time. We intentionally take owned values
/// so the watcher thread doesn't need a lifetime tied to `AppState`.
#[derive(Debug, Clone)]
pub struct WritebackWatcherConfig {
    pub memory_root: PathBuf,
    pub config_path: PathBuf,
    pub env_file: PathBuf,
}

/// Start a watcher. Returns the handle to install in AppState. The watcher
/// thread keeps running until the handle is dropped.
pub fn start<R: Runtime>(
    app: AppHandle<R>,
    cfg: WritebackWatcherConfig,
    http: reqwest::Client,
) -> Result<Arc<WritebackWatcherHandle>, AppError> {
    let decisions_dir = cfg.memory_root.join("decisions");
    if !decisions_dir.is_dir() {
        // Create it so the OS-level watcher has something to watch. The
        // python daemon also expects this dir to exist.
        std::fs::create_dir_all(&decisions_dir).map_err(|e| {
            AppError::internal(
                "writeback_watcher_mkdir",
                format!("{}: {}", decisions_dir.display(), e),
            )
        })?;
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let log = WritebackLog::new(&cfg.memory_root);

    std::thread::spawn(move || {
        run_watch_loop(app, cfg, http, log, stop_rx);
    });

    Ok(Arc::new(WritebackWatcherHandle {
        stop_tx: Some(stop_tx),
    }))
}

/// The watch loop. Lives on a dedicated thread so the debouncer's blocking
/// recv() doesn't tie up tokio.
fn run_watch_loop<R: Runtime>(
    app: AppHandle<R>,
    cfg: WritebackWatcherConfig,
    http: reqwest::Client,
    log: WritebackLog,
    stop_rx: std::sync::mpsc::Receiver<()>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut deb = match new_debouncer(DEBOUNCE, tx) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(error = %e, "writeback watcher: debouncer init failed");
            return;
        }
    };
    let decisions_dir = cfg.memory_root.join("decisions");
    if let Err(e) = deb
        .watcher()
        .watch(&decisions_dir, RecursiveMode::NonRecursive)
    {
        tracing::error!(error = %e, "writeback watcher: watch failed");
        return;
    }

    loop {
        // Try to receive an event. Use a short poll so we can also check the
        // stop signal without spinning up another thread.
        match rx.recv_timeout(Duration::from_millis(750)) {
            Ok(Ok(events)) => {
                for ev in events {
                    let path = ev.path.clone();
                    if !is_decision_file(&path) {
                        continue;
                    }
                    handle_event(&app, &cfg, &http, &log, &path);
                }
            }
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "writeback watcher: notify error");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Cooperative shutdown check.
                if stop_rx.try_recv().is_ok() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if stop_rx.try_recv().is_ok() {
            break;
        }
    }
}

fn is_decision_file(p: &Path) -> bool {
    let ext_match = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !ext_match {
        return false;
    }
    // Skip dotfiles + tmp files notify-debouncer can fire on.
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    !name.starts_with('.') && !name.ends_with(".tmp")
}

/// Handle a single decision-file change. Dispatches to the right adapter
/// after dedup. We block here on the async writeback via Tauri's runtime
/// because the watcher thread isn't a tokio task — using
/// `tauri::async_runtime::block_on` keeps the implementation simple while
/// still letting the actual HTTP call run on the shared runtime.
fn handle_event<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &WritebackWatcherConfig,
    http: &reqwest::Client,
    log: &WritebackLog,
    path: &Path,
) {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "writeback watcher: read failed");
            return;
        }
    };
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let prov = match parse_decision_frontmatter(&raw, &filename) {
        Some(p) => p,
        None => return, // not a writeback-eligible decision
    };
    let rel_path = format!("decisions/{}", filename);

    // Dedup: short-circuit when a prior terminal Posted entry exists.
    let prior = match log.lookup(&rel_path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "writeback watcher: log read failed");
            None
        }
    };
    if let Some(prior) = prior {
        if let WritebackOutcome::Posted { external_url, .. } = &prior.outcome {
            // Record the AlreadyDone follow-up so the UI sees the dedup
            // happen, but skip the HTTP call.
            let outcome = WritebackOutcome::AlreadyDone {
                external_url: external_url.clone(),
            };
            let _ = log.record(&rel_path, &prov.source, &prov.external_id, &outcome);
            let _ = app.emit("writeback:event", &outcome);
            return;
        }
        // For other terminal-and-non-retryable outcomes (Disabled,
        // NotApplicable) we still re-evaluate when the file changes, so
        // toggling the switch back ON immediately picks up the queued
        // decision.
    }

    let outcome = match prov.source.as_str() {
        "github" => match tauri::async_runtime::block_on(github::writeback_decision(
            http,
            &cfg.config_path,
            &prov,
        )) {
            Ok(o) => o,
            Err(e) => WritebackOutcome::Failed {
                error: e.to_string(),
            },
        },
        "linear" => match tauri::async_runtime::block_on(linear::writeback_decision(
            http,
            &cfg.config_path,
            &cfg.env_file,
            &prov,
        )) {
            Ok(o) => o,
            Err(e) => WritebackOutcome::Failed {
                error: e.to_string(),
            },
        },
        other => WritebackOutcome::NotApplicable {
            reason: format!("source '{}' not wired for writeback", other),
        },
    };

    let _ = log.record(&rel_path, &prov.source, &prov.external_id, &outcome);
    let _ = app.emit("writeback:event", &outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_non_markdown_files() {
        assert!(!is_decision_file(Path::new("/tmp/foo.txt")));
        assert!(!is_decision_file(Path::new("/tmp/.hidden.md")));
        assert!(!is_decision_file(Path::new("/tmp/foo.md.tmp")));
        assert!(is_decision_file(Path::new("/tmp/foo.md")));
        assert!(is_decision_file(Path::new("/tmp/Foo.MD")));
    }
}
