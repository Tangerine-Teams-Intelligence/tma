//! Tauri command surface for the v1.7 RMS daemon.
//!
//! The daemon itself lives in `crate::daemon`. This module exposes:
//!   * `daemon_status()` — debug surface returning the latest heartbeat,
//!     pull, brief, and tail of errors (≤ 20).
//!   * `daemon_kick()` — force an immediate heartbeat (used by the UI's
//!     "refresh now" affordance and by integration tests).
//!
//! State: a `DaemonHandle` lives in `AppState.daemon` (an `Arc<Mutex<…>>`).
//! Setup runs in `main.rs` after `commands::setup_state` so the heartbeat
//! starts before the user's first interaction.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

use crate::daemon::{DaemonControl, DaemonStatus};

use super::{AppError, AppState};

/// Slot held in `AppState`. `None` until `start_daemon` resolves.
#[derive(Default)]
pub struct DaemonSlot(pub Mutex<Option<Arc<DaemonControl>>>);

impl DaemonSlot {
    pub fn install(&self, control: Arc<DaemonControl>) {
        *self.0.lock() = Some(control);
    }

    pub fn take_snapshot(&self) -> Option<DaemonStatus> {
        self.0.lock().as_ref().map(|c| c.snapshot())
    }

    pub fn kick(&self) {
        if let Some(c) = self.0.lock().as_ref() {
            c.kick.notify_waiters();
        }
    }

    pub fn stop(&self) {
        if let Some(c) = self.0.lock().take() {
            c.stop.notify_waiters();
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DaemonStatusOut {
    pub running: bool,
    pub last_heartbeat: Option<String>,
    pub last_pull: Option<String>,
    pub last_brief: Option<String>,
    pub last_brief_date: Option<String>,
    pub heartbeat_count: u64,
    pub errors: Vec<String>,
    /// v1.8 Phase 2-B — pre-meeting brief liveness.
    #[serde(default)]
    pub premeeting_briefs_queued: u64,
    #[serde(default)]
    pub last_premeeting_check: Option<String>,
    /// v1.8 Phase 2-D — email source liveness.
    #[serde(default)]
    pub last_email_fetch: Option<String>,
    #[serde(default)]
    pub email_threads_total: u64,
}

#[tauri::command]
pub async fn daemon_status(state: State<'_, AppState>) -> Result<DaemonStatusOut, AppError> {
    let snap = state.daemon.take_snapshot();
    Ok(match snap {
        Some(s) => DaemonStatusOut {
            running: true,
            last_heartbeat: s.last_heartbeat,
            last_pull: s.last_pull,
            last_brief: s.last_brief,
            last_brief_date: s.last_brief_date,
            heartbeat_count: s.heartbeat_count,
            errors: s.errors,
            premeeting_briefs_queued: s.premeeting_briefs_queued,
            last_premeeting_check: s.last_premeeting_check,
            last_email_fetch: s.last_email_fetch,
            email_threads_total: s.email_threads_total,
        },
        None => DaemonStatusOut {
            running: false,
            last_heartbeat: None,
            last_pull: None,
            last_brief: None,
            last_brief_date: None,
            heartbeat_count: 0,
            errors: vec![],
            premeeting_briefs_queued: 0,
            last_premeeting_check: None,
            last_email_fetch: None,
            email_threads_total: 0,
        },
    })
}

#[tauri::command]
pub async fn daemon_kick(state: State<'_, AppState>) -> Result<(), AppError> {
    state.daemon.kick();
    Ok(())
}
