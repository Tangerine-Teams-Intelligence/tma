//! v3.0 §1.1 — Cursor IDE conversation capture.
//!
//! Reads `~/.cursor/conversations/*.json` (POSIX) /
//! `%APPDATA%/Cursor/User/conversations/*.json` (Windows) and emits one
//! atom per conversation file. The conversation JSON shape Cursor writes
//! has evolved across releases; this adapter is permissive — it accepts
//! any of the historical shapes documented below and maps them to the
//! shared [`PersonalAgentAtom`] shape.
//!
//! Accepted shapes (any of these works):
//!
//! ```json
//! { "id": "abc", "title": "...", "messages": [
//!     { "role": "user", "content": "...", "timestamp": "..." },
//!     ...
//! ]}
//! ```
//!
//! ```json
//! { "id": "abc", "messages": [
//!     { "role": "assistant", "text": "..." },
//!     ...
//! ]}
//! ```
//!
//! Schemas we ignore:
//!   * Files with no `messages` array (Cursor's session metadata, not a
//!     conversation).
//!   * Files whose top-level value is an array — Cursor used a list shape
//!     in earlier alphas; we treat each element as a message and synthesize
//!     `id` from the filename stem.
//!
//! Idempotence: the writer compares the source JSON's mtime against the
//! atom file's mtime; if the atom is newer, the conversation is skipped.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Resolve the Cursor conversations directory for the current OS. Returns
/// the path even when it doesn't exist on disk so the Settings UI can
/// render "looking for ... at <path>" before the user installs Cursor.
pub fn cursor_home() -> PathBuf {
    if cfg!(windows) {
        // Cursor on Windows stores its state in two well-known shapes
        // depending on installer version. We prefer `%APPDATA%/Cursor/User/
        // conversations` (the newer one); the alternate path is checked at
        // capture time as a fallback (see `candidate_dirs`).
        if let Ok(roaming) = std::env::var("APPDATA") {
            return PathBuf::from(roaming)
                .join("Cursor")
                .join("User")
                .join("conversations");
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".cursor").join("conversations");
    }
    PathBuf::from(".cursor").join("conversations")
}

/// Every directory we'll probe when scanning for Cursor conversations.
/// First entry is the canonical one; the rest are historical fallbacks.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = vec![cursor_home()];
    if let Some(home) = dirs::home_dir() {
        // POSIX-style fallback even on Windows — some Cursor installs
        // historically wrote into `~/.cursor/conversations` regardless of
        // OS.
        let dot = home.join(".cursor").join("conversations");
        if !v.contains(&dot) {
            v.push(dot);
        }
    }
    v
}

/// Probe — count conversation JSON files across every candidate dir.
/// Returns 0 when nothing is found. Used by the Settings detector.
pub fn count_conversations() -> usize {
    let mut total = 0usize;
    for dir in candidate_dirs() {
        total += list_conversation_files(&dir).len();
    }
    total
}

/// True when at least one candidate directory is on disk. The Settings UI
/// uses this to render a "found" / "not found" badge.
pub fn detected() -> bool {
    candidate_dirs().iter().any(|p| p.is_dir())
}

/// Run one capture pass. Walks every candidate dir, parses each JSON, and
/// writes / refreshes the atom under
/// `<dest_root>/cursor/{conversation-id}.md`.
///
/// `dest_root` is the personal threads directory the caller resolves via
/// `memory_paths::resolve_atom_dir(.., AtomScope::Personal, .., "threads")`.
pub fn capture(dest_root: &Path) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("cursor");
    let target_dir = dest_root.join("cursor");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    for dir in candidate_dirs() {
        for path in list_conversation_files(&dir) {
            match capture_one_conversation(&path, &target_dir) {
                Ok(true) => result.written += 1,
                Ok(false) => result.skipped += 1,
                Err(e) => result
                    .errors
                    .push(format!("{}: {}", path.display(), e)),
            }
        }
    }
    result
}

/// Read a directory and return the absolute paths of every `*.json` file
/// (one level deep — Cursor doesn't nest conversations). Missing dir → empty
/// vec. Non-json entries are silently skipped.
fn list_conversation_files(dir: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .map(|e| e.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

/// Capture one conversation. Returns:
///   * `Ok(true)` — atom file was written or refreshed.
///   * `Ok(false)` — atom file already up to date (skipped).
///   * `Err(_)` — parse / I/O error; caller records and continues.
fn capture_one_conversation(src: &Path, target_dir: &Path) -> Result<bool, String> {
    let src_meta = fs::metadata(src).map_err(|e| format!("metadata: {}", e))?;
    let src_mtime = src_meta.modified().unwrap_or_else(|_| SystemTime::now());
    let src_nanos = system_time_to_nanos(src_mtime);
    let raw = fs::read_to_string(src).map_err(|e| format!("read: {}", e))?;
    let mut parsed = parse_conversation(&raw, src).map_err(|e| format!("parse: {}", e))?;
    parsed.source_mtime_nanos = src_nanos;
    let atom_path = target_dir.join(format!("{}.md", sanitize_id(&parsed.conversation_id)));
    if let Some(prev) = read_atom_source_mtime(&atom_path) {
        if prev >= src_nanos {
            return Ok(false);
        }
    }
    let body = render_atom(&parsed);
    fs::write(&atom_path, body).map_err(|e| format!("write {}: {}", atom_path.display(), e))?;
    // === wave 16 ===
    // Push onto the in-memory activity ring so the React `<ActivityFeed/>`
    // sees this conversation when it re-reads via `activity_recent`. The
    // Tauri command thunk that wraps `capture` fires the
    // `activity:atom_written` event itself.
    let title = if parsed.topic.is_empty() {
        parsed.conversation_id.clone()
    } else {
        parsed.topic.clone()
    };
    let rel = wave16_compute_rel_path(&atom_path);
    let ev = crate::activity::ActivityAtomEvent::new(
        rel,
        title,
        crate::activity::AtomKind::Thread,
    )
    .with_vendor("cursor");
    crate::activity::push_event_to_ring(ev);
    // === end wave 16 ===
    Ok(true)
}

// === wave 16 ===
/// Memory-root-relative path helper. Mirrors the same helper in
/// `personal_agents::claude_code`; duplicated to avoid pulling the module
/// into the public surface of either parser.
fn wave16_compute_rel_path(atom_path: &Path) -> String {
    let s = atom_path.to_string_lossy().replace('\\', "/");
    if let Some(idx) = s.find(".tangerine-memory/") {
        let rest = &s[idx + ".tangerine-memory/".len()..];
        return rest.to_string();
    }
    let parts: Vec<&str> = s.split('/').collect();
    let n = parts.len();
    if n >= 4 {
        parts[n - 4..].join("/")
    } else {
        s
    }
}
// === end wave 16 ===

/// Strip path-traversal and unsafe filename chars from a conversation id so
/// it's safe to use as a basename.
fn sanitize_id(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_alphanumeric() {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "conversation".to_string()
    } else {
        trimmed
    }
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

/// Permissive top-level shape — Cursor has shipped a few variations. We
/// accept either a struct with `messages` or a bare list.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CursorRoot {
    /// `{ id, title, messages: [...] }` shape (current).
    Struct {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        messages: Vec<CursorMessage>,
    },
    /// Bare `[ { role, content }, ... ]` shape (early alphas).
    Bare(Vec<CursorMessage>),
}

/// Permissive message shape. Either `content` (newer) or `text` (legacy)
/// may carry the body; either `timestamp` or `created_at` may carry the
/// time. Anything missing is treated as absent — never an error.
#[derive(Debug, Deserialize, Default)]
struct CursorMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

impl CursorMessage {
    fn body(&self) -> String {
        if let Some(t) = &self.text {
            return t.clone();
        }
        match &self.content {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => {
                // Cursor sometimes splits messages into chunks; concat
                // any text we can find.
                let mut out = String::new();
                for item in items {
                    if let Some(s) = item.as_str() {
                        out.push_str(s);
                    } else if let Some(obj) = item.as_object() {
                        if let Some(s) = obj.get("text").and_then(|v| v.as_str()) {
                            out.push_str(s);
                        }
                    }
                }
                out
            }
            Some(other) => other.to_string(),
            None => String::new(),
        }
    }

    fn ts(&self) -> Option<String> {
        self.timestamp
            .clone()
            .or_else(|| self.created_at.clone())
    }
}

/// Parse a Cursor JSON file into the shared atom shape. The `src` path is
/// only used to derive a fallback conversation id when the JSON omits one.
pub fn parse_conversation(raw: &str, src: &Path) -> Result<PersonalAgentAtom, String> {
    let root: CursorRoot = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let (id_opt, title_opt, messages) = match root {
        CursorRoot::Struct { id, title, messages } => (id, title, messages),
        CursorRoot::Bare(messages) => (None, None, messages),
    };
    if messages.is_empty() {
        return Err("no messages in conversation".to_string());
    }
    let conversation_id = id_opt.unwrap_or_else(|| {
        src.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("conversation")
            .to_string()
    });
    // Topic: prefer `title`, fall back to the first user message.
    let topic = if let Some(t) = title_opt.filter(|t| !t.is_empty()) {
        topic_from_first_message(&t)
    } else {
        let first_user = messages
            .iter()
            .find(|m| m.role.as_deref() == Some("user"))
            .or_else(|| messages.first());
        first_user
            .map(|m| topic_from_first_message(&m.body()))
            .unwrap_or_default()
    };
    let started_at = messages.iter().filter_map(|m| m.ts()).next();
    let ended_at = messages.iter().filter_map(|m| m.ts()).last();
    let message_count = messages.len();
    let body = messages
        .iter()
        .map(|m| {
            let role = match m.role.as_deref() {
                Some("user") => "User",
                Some("assistant") => "Assistant",
                Some(other) => other,
                None => "Message",
            };
            let text = m.body();
            let trimmed = text.trim_end();
            format!("**{}**: {}\n", role, trimmed)
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(PersonalAgentAtom {
        source: "cursor".to_string(),
        conversation_id,
        started_at,
        ended_at,
        message_count,
        topic,
        // Caller (capture_one_conversation) overwrites this with the live
        // source mtime before rendering. parse-only callers (tests, manual
        // sweeps) get 0 which means "never seen" → next capture will refresh.
        source_mtime_nanos: 0,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_struct_shape() -> &'static str {
        r#"{
            "id": "conv-abc",
            "title": "patent v7 review",
            "messages": [
                {"role": "user", "content": "let's go", "timestamp": "2026-04-26T10:00:00Z"},
                {"role": "assistant", "content": "ok", "timestamp": "2026-04-26T10:00:05Z"}
            ]
        }"#
    }

    fn fixture_bare_shape() -> &'static str {
        r#"[
            {"role": "user", "text": "hi"},
            {"role": "assistant", "text": "hello"}
        ]"#
    }

    #[test]
    fn parses_struct_shape() {
        let p = PathBuf::from("/tmp/conv-abc.json");
        let a = parse_conversation(fixture_struct_shape(), &p).unwrap();
        assert_eq!(a.source, "cursor");
        assert_eq!(a.conversation_id, "conv-abc");
        assert_eq!(a.message_count, 2);
        assert_eq!(a.topic, "patent v7 review");
        assert!(a.body.contains("**User**: let's go"));
        assert!(a.body.contains("**Assistant**: ok"));
        assert_eq!(a.started_at.as_deref(), Some("2026-04-26T10:00:00Z"));
        assert_eq!(a.ended_at.as_deref(), Some("2026-04-26T10:00:05Z"));
    }

    #[test]
    fn parses_bare_shape_uses_filename_id() {
        let p = PathBuf::from("/tmp/abc-123.json");
        let a = parse_conversation(fixture_bare_shape(), &p).unwrap();
        assert_eq!(a.conversation_id, "abc-123");
        assert_eq!(a.message_count, 2);
        assert!(a.body.contains("**User**: hi"));
    }

    #[test]
    fn parse_rejects_empty_messages() {
        let p = PathBuf::from("/tmp/x.json");
        let raw = r#"{"id":"x","messages":[]}"#;
        assert!(parse_conversation(raw, &p).is_err());
    }

    #[test]
    fn capture_is_idempotent() {
        // Set up a temp Cursor home with one conversation, run capture
        // twice — second run must skip.
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_cursor_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let src_dir = tmp.join("src");
        let dest_root = tmp.join("dest");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_root).unwrap();
        let src_file = src_dir.join("conv-abc.json");
        fs::write(&src_file, fixture_struct_shape()).unwrap();
        // Patch candidate_dirs by writing into the user's actual cursor home
        // is not possible in unit tests; instead, exercise the inner
        // capture_one_conversation directly so we don't pollute the user's
        // ~/.cursor/.
        let target_dir = dest_root.join("cursor");
        fs::create_dir_all(&target_dir).unwrap();
        let first = capture_one_conversation(&src_file, &target_dir).unwrap();
        assert!(first, "first run should write");
        let second = capture_one_conversation(&src_file, &target_dir).unwrap();
        assert!(!second, "second run should skip (atom up to date)");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sanitize_id_strips_unsafe_chars() {
        assert_eq!(sanitize_id("abc/def"), "abc-def");
        assert_eq!(sanitize_id("../etc"), "etc");
        assert_eq!(sanitize_id(""), "conversation");
        assert_eq!(sanitize_id("abc 123"), "abc-123");
    }
}
