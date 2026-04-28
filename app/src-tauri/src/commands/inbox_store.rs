// === wave 1.13-A ===
//! Wave 1.13-A — canonical Inbox event store + Tauri command surface.
//!
//! NOTE on coexistence with `commands::inbox`:
//!   `commands::inbox` is a Wave 1.13-B placeholder that writes
//!   `<memory_dir>/.tangerine/inbox/{YYYY-MM-DD}.jsonl` shards under a
//!   different in-memory schema (it predates the foundation contract). We
//!   leave that stub untouched (1.13-B owns it) and deliberately scope this
//!   canonical implementation to a sibling file.
//!
//! Storage:
//!   * Append-only JSONL at `<memory_dir>/.tangerine/inbox.jsonl`.
//!   * Each line is one [`InboxEvent`].
//!   * The atom-mention parser fires `inbox_emit` once per mentioned user.
//!
//! Read side:
//!   * `inbox_list { limit?, filter?, forUser? }` returns newest-first events
//!     filtered by `target_user == current user` (so a teammate's events
//!     never leak into your inbox). `forUser` is a test override.
//!   * `inbox_mark_read { eventId }` / `inbox_archive { eventId }` flip
//!     per-event flags. We rewrite the JSONL atomically (read → mutate →
//!     write tmp → rename) so a crash mid-flip never corrupts the store.
//!
//! Frontend wiring:
//!   * Tauri event `inbox:event_created` is emitted on every successful
//!     `inbox_emit`. The AppShell listens and pushes a toast +
//!     `system_notify` when the event targets the current user.
//!   * `app/src/lib/identity.ts` wraps these commands in TS.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use super::AppError;
use crate::commands::identity::{memory_root, normalise_alias, resolve_current_profile};

/// One inbox event. Mirrors the spec struct in the L3 section of the v1.13
/// foundation prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxEvent {
    pub id: String,
    /// One of `mention` | `review_request` | `comment_reply`. Kept as a free
    /// string so 1.13-B / 1.13-C can introduce new kinds without forcing a
    /// coupled migration.
    pub kind: String,
    /// Alias of the user who should see this event in their inbox.
    pub target_user: String,
    /// Alias of the user who triggered the event.
    pub source_user: String,
    /// Repo-relative path of the atom that triggered the event (e.g.
    /// `team/decisions/2026-04-27-pricing.md`). Empty string when the event
    /// has no atom anchor.
    pub source_atom: String,
    /// RFC 3339 UTC timestamp.
    pub timestamp: String,
    /// Free-form payload (e.g. `{ "snippet": "@alice take a look" }`).
    #[serde(default)]
    pub payload: HashMap<String, serde_json::Value>,
    pub read: bool,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxListArgs {
    #[serde(default)]
    pub limit: Option<usize>,
    /// `"unread"` | `"all"` | `"archived"`. Default = `"all"` (i.e. include
    /// read but not archived).
    #[serde(default)]
    pub filter: Option<String>,
    /// Override the current user — only used by tests.
    #[serde(default)]
    pub for_user: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEmitArgs {
    pub kind: String,
    pub target_user: String,
    pub source_atom: String,
    #[serde(default)]
    pub payload: HashMap<String, serde_json::Value>,
    /// Override `source_user` — defaults to the current user.
    #[serde(default)]
    pub source_user: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFlagArgs {
    pub event_id: String,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

pub(crate) fn inbox_path(memory_dir: &Path) -> PathBuf {
    memory_dir.join(".tangerine").join("inbox.jsonl")
}

fn ensure_parent(path: &Path) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("inbox_mkdir", e.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

pub(crate) fn read_all_events(memory_dir: &Path) -> Vec<InboxEvent> {
    let path = inbox_path(memory_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let text = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<InboxEvent> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<InboxEvent>(trimmed) {
            Ok(e) => out.push(e),
            Err(e) => {
                tracing::warn!(error=?e, "wave 1.13-A inbox_store parse failed");
            }
        }
    }
    out
}

pub(crate) fn write_all_events(memory_dir: &Path, events: &[InboxEvent]) -> Result<(), AppError> {
    let path = inbox_path(memory_dir);
    ensure_parent(&path)?;
    let mut buf = String::new();
    for e in events {
        let line = serde_json::to_string(e)
            .map_err(|err| AppError::internal("inbox_serialize", err.to_string()))?;
        buf.push_str(&line);
        buf.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, buf.as_bytes())
        .map_err(|e| AppError::internal("inbox_write", e.to_string()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| AppError::internal("inbox_rename", e.to_string()))?;
    Ok(())
}

pub(crate) fn append_event(memory_dir: &Path, event: &InboxEvent) -> Result<(), AppError> {
    use std::io::Write;
    let path = inbox_path(memory_dir);
    ensure_parent(&path)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::internal("inbox_open", e.to_string()))?;
    let line = serde_json::to_string(event)
        .map_err(|e| AppError::internal("inbox_serialize", e.to_string()))?;
    writeln!(f, "{}", line).map_err(|e| AppError::internal("inbox_append", e.to_string()))?;
    Ok(())
}

/// UUIDv4 prefixed with the kind so a human reading the JSONL can spot what
/// the event is at a glance.
fn new_event_id(kind: &str) -> String {
    format!("{}-{}", kind, uuid::Uuid::new_v4().simple())
}

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn inbox_list(args: InboxListArgs) -> Result<Vec<InboxEvent>, AppError> {
    let memory_dir = memory_root();
    let me = match args.for_user.clone() {
        Some(u) => normalise_alias(&u),
        None => resolve_current_profile(&memory_dir).alias,
    };
    let filter = args.filter.unwrap_or_else(|| "all".to_string());
    let mut events: Vec<InboxEvent> = read_all_events(&memory_dir)
        .into_iter()
        .filter(|e| e.target_user == me)
        .filter(|e| match filter.as_str() {
            "unread" => !e.read && !e.archived,
            "archived" => e.archived,
            _ => !e.archived, // "all" excludes archived (they get their own tab)
        })
        .collect();
    events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if let Some(lim) = args.limit {
        events.truncate(lim);
    }
    Ok(events)
}

#[tauri::command]
pub async fn inbox_emit<R: Runtime>(
    app: AppHandle<R>,
    args: InboxEmitArgs,
) -> Result<InboxEvent, AppError> {
    let memory_dir = memory_root();
    let me = resolve_current_profile(&memory_dir).alias;
    let source_user = args
        .source_user
        .map(|s| normalise_alias(&s))
        .unwrap_or(me);
    let target_user = normalise_alias(&args.target_user);
    let event = InboxEvent {
        id: new_event_id(&args.kind),
        kind: args.kind,
        target_user,
        source_user,
        source_atom: args.source_atom,
        timestamp: Utc::now().to_rfc3339(),
        payload: args.payload,
        read: false,
        archived: false,
    };
    append_event(&memory_dir, &event)?;
    if let Err(e) = app.emit("inbox:event_created", &event) {
        tracing::warn!(error=?e, "wave 1.13-A inbox emit failed");
    }
    Ok(event)
}

#[tauri::command]
pub async fn inbox_mark_read(args: InboxFlagArgs) -> Result<(), AppError> {
    let memory_dir = memory_root();
    let mut events = read_all_events(&memory_dir);
    let mut found = false;
    for e in events.iter_mut() {
        if e.id == args.event_id {
            e.read = true;
            found = true;
        }
    }
    if found {
        write_all_events(&memory_dir, &events)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn inbox_archive(args: InboxFlagArgs) -> Result<(), AppError> {
    let memory_dir = memory_root();
    let mut events = read_all_events(&memory_dir);
    let mut found = false;
    for e in events.iter_mut() {
        if e.id == args.event_id {
            e.archived = true;
            e.read = true;
            found = true;
        }
    }
    if found {
        write_all_events(&memory_dir, &events)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn inbox_mark_all_read() -> Result<u32, AppError> {
    let memory_dir = memory_root();
    let me = resolve_current_profile(&memory_dir).alias;
    let mut events = read_all_events(&memory_dir);
    let mut count: u32 = 0;
    for e in events.iter_mut() {
        if e.target_user == me && !e.read && !e.archived {
            e.read = true;
            count += 1;
        }
    }
    if count > 0 {
        write_all_events(&memory_dir, &events)?;
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fresh_dir(suffix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_w113a_inbox_{}_{}",
            suffix,
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_event(kind: &str, target: &str, source: &str) -> InboxEvent {
        InboxEvent {
            id: new_event_id(kind),
            kind: kind.to_string(),
            target_user: target.to_string(),
            source_user: source.to_string(),
            source_atom: "team/decisions/x.md".to_string(),
            timestamp: Utc::now().to_rfc3339(),
            payload: HashMap::new(),
            read: false,
            archived: false,
        }
    }

    #[test]
    fn append_and_read_round_trip() {
        let dir = fresh_dir("append");
        let e1 = make_event("mention", "alice", "bob");
        let e2 = make_event("review_request", "alice", "carol");
        append_event(&dir, &e1).unwrap();
        append_event(&dir, &e2).unwrap();
        let all = read_all_events(&dir);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].kind, "mention");
        assert_eq!(all[1].kind, "review_request");
    }

    #[test]
    fn read_skips_blank_and_invalid_lines() {
        let dir = fresh_dir("skip_invalid");
        ensure_parent(&inbox_path(&dir)).unwrap();
        let path = inbox_path(&dir);
        let valid = serde_json::to_string(&make_event("mention", "alice", "bob")).unwrap();
        let body = format!("{}\n\n{{not-json}}\n{}\n", valid, valid);
        fs::write(&path, body).unwrap();
        let all = read_all_events(&dir);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn write_all_overwrites_atomically() {
        let dir = fresh_dir("rewrite");
        let e1 = make_event("mention", "alice", "bob");
        append_event(&dir, &e1).unwrap();
        let e2 = make_event("comment_reply", "alice", "carol");
        write_all_events(&dir, &[e2.clone()]).unwrap();
        let all = read_all_events(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, e2.id);
    }

    #[test]
    fn filter_by_target_user_excludes_others() {
        let dir = fresh_dir("filter_target");
        let e1 = make_event("mention", "alice", "bob");
        let e2 = make_event("mention", "bob", "alice");
        let mut e3 = make_event("review_request", "alice", "carol");
        e3.archived = true;
        append_event(&dir, &e1).unwrap();
        append_event(&dir, &e2).unwrap();
        append_event(&dir, &e3).unwrap();

        let filtered: Vec<InboxEvent> = read_all_events(&dir)
            .into_iter()
            .filter(|e| e.target_user == "alice")
            .filter(|e| !e.archived)
            .collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, e1.id);
    }

    #[test]
    fn mark_read_flips_only_target() {
        let dir = fresh_dir("mark_read");
        let e1 = make_event("mention", "alice", "bob");
        let e2 = make_event("mention", "alice", "carol");
        append_event(&dir, &e1).unwrap();
        append_event(&dir, &e2).unwrap();

        let mut all = read_all_events(&dir);
        for e in all.iter_mut() {
            if e.id == e1.id {
                e.read = true;
            }
        }
        write_all_events(&dir, &all).unwrap();
        let all2 = read_all_events(&dir);
        let r1 = all2.iter().find(|e| e.id == e1.id).unwrap();
        let r2 = all2.iter().find(|e| e.id == e2.id).unwrap();
        assert!(r1.read);
        assert!(!r2.read);
    }

    #[test]
    fn payload_round_trips_arbitrary_json() {
        let dir = fresh_dir("payload");
        let mut payload = HashMap::new();
        payload.insert(
            "snippet".to_string(),
            serde_json::Value::String("@alice take a look".to_string()),
        );
        payload.insert(
            "line_no".to_string(),
            serde_json::Value::Number(serde_json::Number::from(42)),
        );
        let mut e = make_event("mention", "alice", "bob");
        e.payload = payload.clone();
        append_event(&dir, &e).unwrap();
        let all = read_all_events(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].payload.get("snippet").and_then(|v| v.as_str()),
            Some("@alice take a look")
        );
        assert_eq!(
            all[0].payload.get("line_no").and_then(|v| v.as_i64()),
            Some(42)
        );
    }
}
// === end wave 1.13-A ===
