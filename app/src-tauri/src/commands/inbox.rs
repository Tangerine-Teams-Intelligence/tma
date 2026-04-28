// === wave 1.13-B ===
//! Wave 1.13-B → Wave 1.13-A bridge for synchronous Inbox emits.
//!
//! Wave 1.13-A's canonical `inbox_emit` (in `commands::inbox_store`) is a
//! Tauri command that needs an `AppHandle` so it can fire the
//! `inbox:event_created` Tauri event. The 1.13-B review/comment code paths
//! call from sync contexts (and from inside cargo tests, where there's no
//! AppHandle) — so we expose a thin sync shim that writes through 1.13-A's
//! `append_event` helper directly. The Tauri-event side-effect is skipped
//! when called from this shim; the event still lands in the on-disk store
//! and the next `inbox_list` poll picks it up. (1.13-A's React renderer
//! also has a heartbeat poll on top of the live event subscription, so
//! the missed event isn't lost.)
//!
//! When 1.13-A's command surface adds an `AppHandle`-free emit primitive
//! we will swap this shim to call that. Until then, this is the seam.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::commands::inbox_store::{append_event, InboxEvent as StoreEvent};
use crate::commands::AppError;

/// Wave 1.13-B's view of an inbox event. Maps onto 1.13-A's `InboxEvent`
/// 1:1 via `to_store`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxEvent {
    pub id: String,
    pub kind: InboxEventKind,
    pub recipient: String,
    pub source: String,
    pub payload: serde_json::Value,
    pub at: String,
    #[serde(default)]
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxEventKind {
    /// Review requested — recipient is a reviewer on a freshly-proposed atom.
    ReviewRequest,
    /// Inline comment mentions recipient via `@username`.
    CommentMention,
    /// Reply on a thread the recipient is part of.
    CommentReply,
}

impl InboxEventKind {
    fn as_kind_str(&self) -> &'static str {
        match self {
            Self::ReviewRequest => "review_request",
            Self::CommentMention => "mention",
            Self::CommentReply => "comment_reply",
        }
    }
}

fn default_memory_root() -> std::path::PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".tangerine-memory")
    } else {
        std::path::PathBuf::from(".tangerine-memory")
    }
}

/// Convert 1.13-B's view into 1.13-A's store event. Payload is serialized
/// to a `HashMap<String, Value>` since that's what the canonical store
/// keeps on disk.
fn to_store(event: InboxEvent) -> StoreEvent {
    let payload = match event.payload {
        serde_json::Value::Object(map) => {
            let mut h: HashMap<String, serde_json::Value> = HashMap::new();
            for (k, v) in map {
                h.insert(k, v);
            }
            h
        }
        other => {
            let mut h = HashMap::new();
            h.insert("data".to_string(), other);
            h
        }
    };
    StoreEvent {
        id: event.id,
        kind: event.kind.as_kind_str().to_string(),
        target_user: event.recipient,
        source_user: "system".to_string(),
        source_atom: event.source,
        timestamp: event.at,
        payload,
        read: event.read,
        archived: false,
    }
}

/// Append a single Inbox event into Wave 1.13-A's canonical JSONL store.
/// Best-effort — failures are logged and dropped (Inbox writes must not
/// block the review/comment flow they piggy-back on).
pub fn inbox_emit(event: InboxEvent) -> Result<String, AppError> {
    let root = default_memory_root();
    inbox_emit_in(&root, event)
}

/// Test-friendly variant — caller provides the memory root.
pub fn inbox_emit_in(memory_root: &Path, event: InboxEvent) -> Result<String, AppError> {
    let id = event.id.clone();
    let store_event = to_store(event);
    append_event(memory_root, &store_event)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::path::PathBuf;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_w113b_inbox_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn emit_lands_in_canonical_store() {
        let root = tmp_root();
        let ev = InboxEvent {
            id: "rr_test_1".to_string(),
            kind: InboxEventKind::ReviewRequest,
            recipient: "alex".to_string(),
            source: "team/decisions/x.md".to_string(),
            payload: serde_json::json!({ "atom_title": "x" }),
            at: Utc::now().to_rfc3339(),
            read: false,
        };
        inbox_emit_in(&root, ev).unwrap();
        // Verify the canonical JSONL got the event.
        let on_disk = crate::commands::inbox_store::inbox_path(&root);
        let body = std::fs::read_to_string(&on_disk).unwrap();
        assert!(body.contains("rr_test_1"));
        assert!(body.contains("review_request"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn comment_mention_kind_serializes_as_mention() {
        let root = tmp_root();
        let ev = InboxEvent {
            id: "cm_1".into(),
            kind: InboxEventKind::CommentMention,
            recipient: "sam".into(),
            source: "team/decisions/y.md".into(),
            payload: serde_json::json!({}),
            at: Utc::now().to_rfc3339(),
            read: false,
        };
        inbox_emit_in(&root, ev).unwrap();
        let body = std::fs::read_to_string(crate::commands::inbox_store::inbox_path(&root)).unwrap();
        assert!(body.contains("\"kind\":\"mention\""));
        let _ = std::fs::remove_dir_all(&root);
    }
}
// === end wave 1.13-B ===
