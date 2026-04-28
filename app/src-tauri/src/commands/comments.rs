// === wave 1.13-B ===
//! Wave 1.13-B L5 — Inline comment threads anchored to atom paragraphs.
//!
//! Storage: append-only JSONL under
//! `<memory_root>/.tangerine/comments/{atom_path_hash}.jsonl`. Each line
//! is one `CommentEvent` (create / resolve / unresolve / archive). The
//! current snapshot is reduced from the event log on every read — keeps
//! the write path zero-coordination (any process can append).
//!
//! Anchor: `ParagraphAnchor` references a paragraph by index +
//! optional char-offset range within the body (post-frontmatter). Anchor
//! stability across edits is best-effort: when the anchored paragraph
//! still exists at the same index, the comment renders inline; when the
//! atom shrinks past that index, the comment falls into an "orphaned"
//! bucket the sidebar surfaces at the bottom (one click → re-anchor).
//! The orphaned-bucket UI is a 1.13-C concern; this module just exposes
//! the truth.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::inbox::{inbox_emit, InboxEvent, InboxEventKind};
use crate::commands::AppError;

// ---------------------------------------------------------------------------
// Types

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParagraphAnchor {
    pub paragraph_index: u32,
    pub char_offset_start: u32,
    pub char_offset_end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub thread_id: String,
    pub atom_path: String,
    pub anchor: ParagraphAnchor,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Reply parent (in-thread); None for thread root.
    pub parent_id: Option<String>,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentThread {
    pub thread_id: String,
    pub atom_path: String,
    pub anchor: ParagraphAnchor,
    pub comments: Vec<Comment>,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CommentEvent {
    Create(Comment),
    Resolve { thread_id: String, at: String, by: String },
    Unresolve { thread_id: String, at: String, by: String },
    Archive { thread_id: String, at: String, by: String },
}

// ---------------------------------------------------------------------------
// Storage

fn default_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

fn comments_dir(memory_root: &Path) -> PathBuf {
    memory_root.join(".tangerine").join("comments")
}

fn atom_log_path(memory_root: &Path, atom_path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(atom_path.as_bytes());
    let h = hex::encode(hasher.finalize());
    comments_dir(memory_root).join(format!("{}.jsonl", &h[..16]))
}

fn append_event(memory_root: &Path, atom_path: &str, event: CommentEvent) -> Result<(), AppError> {
    let path = atom_log_path(memory_root, atom_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_comments", e.to_string()))?;
    }
    let mut line = serde_json::to_string(&event)?;
    line.push('\n');
    use std::io::Write as _;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| AppError::internal("open_comments", e.to_string()))?;
    f.write_all(line.as_bytes())
        .map_err(|e| AppError::internal("write_comments", e.to_string()))?;
    Ok(())
}

fn read_events(memory_root: &Path, atom_path: &str) -> Result<Vec<CommentEvent>, AppError> {
    let path = atom_log_path(memory_root, atom_path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal("read_comments", e.to_string()))?;
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(ev) = serde_json::from_str::<CommentEvent>(line) {
            out.push(ev);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Reduction — replay the event log into thread snapshots.

fn reduce(events: Vec<CommentEvent>) -> Vec<CommentThread> {
    use std::collections::BTreeMap;
    let mut threads: BTreeMap<String, CommentThread> = BTreeMap::new();
    let mut resolved_flags: std::collections::HashMap<String, bool> = Default::default();
    let mut archived: std::collections::HashSet<String> = Default::default();

    for ev in events {
        match ev {
            CommentEvent::Create(c) => {
                let entry = threads
                    .entry(c.thread_id.clone())
                    .or_insert_with(|| CommentThread {
                        thread_id: c.thread_id.clone(),
                        atom_path: c.atom_path.clone(),
                        anchor: c.anchor.clone(),
                        comments: Vec::new(),
                        resolved: false,
                    });
                entry.comments.push(c);
            }
            CommentEvent::Resolve { thread_id, .. } => {
                resolved_flags.insert(thread_id, true);
            }
            CommentEvent::Unresolve { thread_id, .. } => {
                resolved_flags.insert(thread_id, false);
            }
            CommentEvent::Archive { thread_id, .. } => {
                archived.insert(thread_id);
            }
        }
    }

    let mut out: Vec<CommentThread> = threads
        .into_iter()
        .filter(|(id, _)| !archived.contains(id))
        .map(|(_, mut t)| {
            t.resolved = resolved_flags.get(&t.thread_id).copied().unwrap_or(false);
            for c in &mut t.comments {
                c.resolved = t.resolved;
            }
            // Sort comments chronologically.
            t.comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            t
        })
        .collect();
    out.sort_by_key(|t| (t.anchor.paragraph_index, t.anchor.char_offset_start));
    out
}

// ---------------------------------------------------------------------------
// Mention extraction — naive `@username` scanner.

/// Extract `@username` mentions from a comment body. Username = `[A-Za-z0-9_-]+`,
/// preceded by start-of-string or whitespace.
pub fn extract_mentions(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() {
                let b = bytes[end];
                if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                    end += 1;
                } else {
                    break;
                }
            }
            if end > start {
                let name = body[start..end].to_string();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Public Tauri commands

#[tauri::command]
pub async fn comments_list(atom_path: String) -> Result<Vec<CommentThread>, AppError> {
    let root = default_memory_root()?;
    let events = read_events(&root, &atom_path)?;
    Ok(reduce(events))
}

#[tauri::command]
pub async fn comments_create(
    atom_path: String,
    anchor: ParagraphAnchor,
    body: String,
    author: String,
    parent_id: Option<String>,
) -> Result<Comment, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::user("empty_body", "comment body cannot be empty"));
    }
    let root = default_memory_root()?;
    let id = format!("c_{}", uuid::Uuid::new_v4().simple());
    let thread_id = match &parent_id {
        Some(pid) => find_thread_for_comment(&root, &atom_path, pid)?
            .unwrap_or_else(|| pid.clone()),
        None => format!("th_{}", uuid::Uuid::new_v4().simple()),
    };
    let now = Utc::now().to_rfc3339();
    let comment = Comment {
        id: id.clone(),
        thread_id: thread_id.clone(),
        atom_path: atom_path.clone(),
        anchor: anchor.clone(),
        author: author.clone(),
        body: body.clone(),
        created_at: now.clone(),
        parent_id,
        resolved: false,
    };
    append_event(&root, &atom_path, CommentEvent::Create(comment.clone()))?;

    // Fire one Inbox event per `@mention` (excluding the author themselves).
    for recipient in extract_mentions(&body) {
        if recipient == author {
            continue;
        }
        let event = InboxEvent {
            id: format!("cm_{}_{}", recipient, id),
            kind: InboxEventKind::CommentMention,
            recipient,
            source: atom_path.clone(),
            payload: serde_json::json!({
                "atom_path": atom_path,
                "thread_id": thread_id,
                "comment_id": id,
                "author": author,
                "excerpt": truncate(&body, 140),
            }),
            at: now.clone(),
            read: false,
        };
        let _ = inbox_emit(event);
    }
    Ok(comment)
}

#[tauri::command]
pub async fn comments_resolve(
    atom_path: String,
    thread_id: String,
    by: String,
) -> Result<(), AppError> {
    let root = default_memory_root()?;
    append_event(
        &root,
        &atom_path,
        CommentEvent::Resolve {
            thread_id,
            at: Utc::now().to_rfc3339(),
            by,
        },
    )
}

#[tauri::command]
pub async fn comments_unresolve(
    atom_path: String,
    thread_id: String,
    by: String,
) -> Result<(), AppError> {
    let root = default_memory_root()?;
    append_event(
        &root,
        &atom_path,
        CommentEvent::Unresolve {
            thread_id,
            at: Utc::now().to_rfc3339(),
            by,
        },
    )
}

#[tauri::command]
pub async fn comments_archive(
    atom_path: String,
    thread_id: String,
    by: String,
) -> Result<(), AppError> {
    let root = default_memory_root()?;
    append_event(
        &root,
        &atom_path,
        CommentEvent::Archive {
            thread_id,
            at: Utc::now().to_rfc3339(),
            by,
        },
    )
}

// ---------------------------------------------------------------------------
// Helpers

fn find_thread_for_comment(
    memory_root: &Path,
    atom_path: &str,
    comment_id: &str,
) -> Result<Option<String>, AppError> {
    let events = read_events(memory_root, atom_path)?;
    for ev in events {
        if let CommentEvent::Create(c) = ev {
            if c.id == comment_id {
                return Ok(Some(c.thread_id));
            }
        }
    }
    Ok(None)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.min(s.len())])
    }
}

// ---------------------------------------------------------------------------
// Test-friendly variants

#[cfg(test)]
fn comments_create_in(
    memory_root: &Path,
    atom_path: &str,
    anchor: ParagraphAnchor,
    body: &str,
    author: &str,
    parent_id: Option<String>,
) -> Result<Comment, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::user("empty_body", "comment body cannot be empty"));
    }
    let id = format!("c_{}", uuid::Uuid::new_v4().simple());
    let thread_id = match &parent_id {
        Some(pid) => find_thread_for_comment(memory_root, atom_path, pid)?
            .unwrap_or_else(|| pid.clone()),
        None => format!("th_{}", uuid::Uuid::new_v4().simple()),
    };
    let now = Utc::now().to_rfc3339();
    let comment = Comment {
        id,
        thread_id,
        atom_path: atom_path.to_string(),
        anchor,
        author: author.to_string(),
        body: body.to_string(),
        created_at: now,
        parent_id,
        resolved: false,
    };
    append_event(memory_root, atom_path, CommentEvent::Create(comment.clone()))?;
    Ok(comment)
}

#[cfg(test)]
fn comments_list_in(memory_root: &Path, atom_path: &str) -> Result<Vec<CommentThread>, AppError> {
    Ok(reduce(read_events(memory_root, atom_path)?))
}

#[cfg(test)]
fn comments_resolve_in(memory_root: &Path, atom_path: &str, thread_id: &str) -> Result<(), AppError> {
    append_event(
        memory_root,
        atom_path,
        CommentEvent::Resolve {
            thread_id: thread_id.to_string(),
            at: Utc::now().to_rfc3339(),
            by: "test".to_string(),
        },
    )
}

#[cfg(test)]
fn comments_archive_in(memory_root: &Path, atom_path: &str, thread_id: &str) -> Result<(), AppError> {
    append_event(
        memory_root,
        atom_path,
        CommentEvent::Archive {
            thread_id: thread_id.to_string(),
            at: Utc::now().to_rfc3339(),
            by: "test".to_string(),
        },
    )
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "tii_cm_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn anchor(p: u32) -> ParagraphAnchor {
        ParagraphAnchor {
            paragraph_index: p,
            char_offset_start: 0,
            char_offset_end: 10,
        }
    }

    #[test]
    fn create_then_list_returns_thread() {
        let root = tmp_root();
        let atom = "team/decisions/x.md";
        let c = comments_create_in(&root, atom, anchor(0), "looks good", "alex", None).unwrap();
        let threads = comments_list_in(&root, atom).unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].comments.len(), 1);
        assert_eq!(threads[0].comments[0].body, "looks good");
        assert_eq!(threads[0].thread_id, c.thread_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reply_groups_into_same_thread() {
        let root = tmp_root();
        let atom = "team/decisions/y.md";
        let parent = comments_create_in(&root, atom, anchor(1), "first", "alex", None).unwrap();
        let _reply = comments_create_in(
            &root,
            atom,
            anchor(1),
            "agreed",
            "sam",
            Some(parent.id.clone()),
        )
        .unwrap();
        let threads = comments_list_in(&root, atom).unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].comments.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_marks_thread() {
        let root = tmp_root();
        let atom = "team/decisions/r.md";
        let c = comments_create_in(&root, atom, anchor(0), "x", "a", None).unwrap();
        comments_resolve_in(&root, atom, &c.thread_id).unwrap();
        let threads = comments_list_in(&root, atom).unwrap();
        assert_eq!(threads.len(), 1);
        assert!(threads[0].resolved);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn archive_drops_thread() {
        let root = tmp_root();
        let atom = "team/decisions/a.md";
        let c = comments_create_in(&root, atom, anchor(0), "x", "a", None).unwrap();
        comments_archive_in(&root, atom, &c.thread_id).unwrap();
        let threads = comments_list_in(&root, atom).unwrap();
        assert_eq!(threads.len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_body_rejected() {
        let root = tmp_root();
        let err = comments_create_in(&root, "x.md", anchor(0), "   ", "a", None).unwrap_err();
        assert!(format!("{err:?}").contains("empty_body"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_mentions_basic() {
        let m = extract_mentions("hey @alex and @sam-w please look");
        assert_eq!(m, vec!["alex".to_string(), "sam-w".to_string()]);
    }

    #[test]
    fn extract_mentions_dedupes() {
        let m = extract_mentions("@alex @alex see this @alex");
        assert_eq!(m, vec!["alex".to_string()]);
    }

    #[test]
    fn extract_mentions_ignores_email_at() {
        let m = extract_mentions("contact me at user@host.com please");
        // `user@host.com` has `@` preceded by a non-whitespace char (`r`),
        // so we don't extract.
        assert_eq!(m, vec!["host".to_string()].into_iter().filter(|_| false).collect::<Vec<_>>());
    }

    #[test]
    fn multiple_threads_per_atom() {
        let root = tmp_root();
        let atom = "team/decisions/m.md";
        comments_create_in(&root, atom, anchor(0), "x1", "a", None).unwrap();
        comments_create_in(&root, atom, anchor(2), "x2", "b", None).unwrap();
        comments_create_in(&root, atom, anchor(5), "x3", "c", None).unwrap();
        let threads = comments_list_in(&root, atom).unwrap();
        assert_eq!(threads.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }
}
// === end wave 1.13-B ===
