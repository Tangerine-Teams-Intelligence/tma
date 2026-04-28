// === wave 1.13-B ===
//! Crate-root `inbox` module — coordination shim.
//!
//! `crate::agi::mention_extractor` (Wave 1.13-C) was written against
//! `use crate::inbox::{inbox_emit, team_roster, InboxEvent};` — a
//! lightweight in-process queue surface that pre-dated Wave 1.13-A's
//! canonical `commands::inbox_store` JSONL store. We expose the same
//! shapes here so 1.13-C compiles, while routing all writes through
//! 1.13-A's persistent store via `commands::inbox_store::append_event`.
//!
//! This file is owned by Wave 1.13-B (the collab-loop wave that needs
//! the build to pass to ship review/comment events). 1.13-A will
//! collapse this shim into its own module when it does the next pass.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::inbox_store::{
    append_event as canonical_append, inbox_path, InboxEvent as CanonicalEvent,
};

/// Cap on the in-memory event ring used by `inbox_drain_for_test`.
pub const INBOX_RING_CAP: usize = 256;

/// Inbox event payload — Wave 1.13-C's view. Maps onto Wave 1.13-A's
/// `InboxEvent` 1:1 inside `inbox_emit` so the persistent store sees the
/// same record either way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxEvent {
    pub kind: String,
    pub target_user: String,
    pub source_user: String,
    pub source_atom: String,
    pub payload: HashMap<String, Value>,
    pub emitted_at: String,
}

impl InboxEvent {
    pub fn new(
        kind: impl Into<String>,
        target_user: impl Into<String>,
        source_user: impl Into<String>,
        source_atom: impl Into<String>,
        payload: HashMap<String, Value>,
    ) -> Self {
        Self {
            kind: kind.into(),
            target_user: target_user.into(),
            source_user: source_user.into(),
            source_atom: source_atom.into(),
            payload,
            emitted_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

pub type EmitResult = Result<(), String>;

fn default_memory_root() -> std::path::PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".tangerine-memory")
    } else {
        std::path::PathBuf::from(".tangerine-memory")
    }
}

/// Emit an event into Wave 1.13-A's canonical store. Also pushed onto an
/// in-memory ring so test code can drain it without touching disk.
pub fn inbox_emit(event: InboxEvent) -> EmitResult {
    backend::push(event.clone());
    let ce = CanonicalEvent {
        id: format!("{}-{}", event.kind, uuid::Uuid::new_v4().simple()),
        kind: event.kind.clone(),
        target_user: event.target_user.clone(),
        source_user: event.source_user.clone(),
        source_atom: event.source_atom.clone(),
        timestamp: event.emitted_at.clone(),
        payload: event.payload.clone(),
        read: false,
        archived: false,
    };
    let root = default_memory_root();
    // Best-effort persistence — never fail the caller's pipeline because
    // the store rejected a write. The in-memory drain still has the event.
    let _ = canonical_append(&root, &ce);
    let _ = inbox_path(&root); // silence the unused-import warning
    Ok(())
}

/// Test-only drain — returns and clears the in-memory ring.
pub fn inbox_drain_for_test() -> Vec<InboxEvent> {
    backend::drain()
}

mod backend {
    use super::{InboxEvent, INBOX_RING_CAP};
    use once_cell::sync::Lazy;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    static RING: Lazy<Mutex<VecDeque<InboxEvent>>> =
        Lazy::new(|| Mutex::new(VecDeque::with_capacity(INBOX_RING_CAP)));

    pub(super) fn push(event: InboxEvent) {
        if let Ok(mut g) = RING.lock() {
            if g.len() >= INBOX_RING_CAP {
                g.pop_front();
            }
            g.push_back(event);
        }
    }

    pub(super) fn drain() -> Vec<InboxEvent> {
        let mut g = match RING.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        g.drain(..).collect()
    }
}

static TEAM_ROSTER: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

pub fn set_team_roster(handles: Vec<String>) {
    if let Ok(mut g) = TEAM_ROSTER.lock() {
        *g = handles
            .into_iter()
            .map(|h| h.trim().to_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
        g.sort();
        g.dedup();
    }
}

pub fn team_roster() -> Vec<String> {
    TEAM_ROSTER.lock().map(|g| g.clone()).unwrap_or_default()
}
// === end wave 1.13-B ===
