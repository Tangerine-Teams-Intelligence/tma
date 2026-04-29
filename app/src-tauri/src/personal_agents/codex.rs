//! v3.0 §1.3 — Codex CLI conversation capture.
//!
//! The Codex CLI is in active development and the on-disk session shape
//! has not stabilized as of v3.0-alpha.1. This adapter is best-effort:
//! it probes a list of plausible session paths, parses any JSON / JSONL
//! it finds, and tries to extract a user-visible message stream. When the
//! schema is unfamiliar the adapter records an `unknown_schema` error
//! and moves on — never panics.
//!
//! Probed paths (first match wins; we walk every existing one):
//!   * `~/.config/openai/sessions/`           (the spec's anchor)
//!   * `~/.codex/sessions/`                   (npm CLI fallback)
//!   * `%APPDATA%/Codex/sessions/`            (Windows fallback)
//!
//! Atom output: `<dest_root>/codex/{session-id}.md`. The session id is
//! taken from the JSON's `id` / `session_id` field when present, else
//! derived from the source filename.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Every directory we'll probe for Codex session files. First entry is the
/// platform-canonical one; the rest are best-effort fallbacks. v1.15.2
/// fix #2 — Windows surfaces `%APPDATA%\Codex\sessions` first because
/// the OpenAI Codex CLI on Windows writes there (the POSIX
/// `~/.config/openai/sessions` path is Linux/macOS only and never exists
/// on Windows).
fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    // Platform-canonical first — the Settings UI shows the head of this
    // list as "Looking for X at <path>".
    if let Some(p) = platform_canonical_dir() {
        v.push(p);
    }
    // POSIX defaults — kept on every OS so users with cross-platform
    // dotfiles or WSL setups still capture.
    if let Some(home) = dirs::home_dir() {
        let posix = home.join(".config").join("openai").join("sessions");
        if !v.contains(&posix) {
            v.push(posix);
        }
        let dot = home.join(".codex").join("sessions");
        if !v.contains(&dot) {
            v.push(dot);
        }
    }
    v
}

/// Resolve the canonical Codex sessions dir for the current OS. Used by
/// the Settings UI's "looking for X at <path>" line. Returns the
/// platform-canonical path even when missing on disk so the user sees
/// the Windows path on Windows, not the POSIX placeholder.
///
///   * Windows: `%APPDATA%\Codex\sessions\`
///   * macOS:   `~/.config/openai/sessions/`
///   * Linux:   `~/.config/openai/sessions/`
pub fn codex_home() -> PathBuf {
    if let Some(p) = platform_canonical_dir() {
        return p;
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".config").join("openai").join("sessions");
    }
    PathBuf::from(".config").join("openai").join("sessions")
}

/// Platform-canonical Codex sessions dir. Pulled into a helper so the
/// candidate-dir builder and the Settings-facing `codex_home()` agree.
fn platform_canonical_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(cfg) = dirs::config_dir() {
            return Some(cfg.join("Codex").join("sessions"));
        }
        if let Ok(app) = std::env::var("APPDATA") {
            return Some(PathBuf::from(app).join("Codex").join("sessions"));
        }
        return None;
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            return Some(home.join(".config").join("openai").join("sessions"));
        }
        return None;
    }
    #[allow(unreachable_code)]
    None
}

pub fn detected() -> bool {
    candidate_dirs().iter().any(|p| p.is_dir())
}

// === v1.14.5 round-6 ===
/// Structured detection — see `cursor::detection_status` for the
/// trust-collapse rationale. AccessDenied wins over NotInstalled so a
/// perms problem on `~/.config/openai/sessions/` doesn't masquerade as
/// "Codex not installed".
pub fn detection_status() -> super::PersonalAgentDetectionStatus {
    super::probe_candidates(&candidate_dirs())
}
// === end v1.14.5 round-6 ===

pub fn count_conversations() -> usize {
    let mut total = 0usize;
    for dir in candidate_dirs() {
        total += list_session_files(&dir).len();
    }
    total
}

pub fn capture(dest_root: &Path) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("codex");
    let target_dir = dest_root.join("codex");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    for dir in candidate_dirs() {
        for path in list_session_files(&dir) {
            match capture_one(&path, &target_dir) {
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

fn list_session_files(dir: &Path) -> Vec<PathBuf> {
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
                    .map(|e| {
                        let s = e.to_string_lossy().to_lowercase();
                        s == "json" || s == "jsonl" || s == "log"
                    })
                    .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

fn capture_one(src: &Path, target_dir: &Path) -> Result<bool, String> {
    let src_meta = fs::metadata(src).map_err(|e| format!("metadata: {}", e))?;
    let src_mtime = src_meta.modified().unwrap_or_else(|_| SystemTime::now());
    let src_nanos = system_time_to_nanos(src_mtime);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    let provisional = target_dir.join(format!("{}.md", sanitize_id(&stem)));
    if let Some(prev) = read_atom_source_mtime(&provisional) {
        if prev >= src_nanos {
            return Ok(false);
        }
    }
    let raw = fs::read_to_string(src).map_err(|e| format!("read: {}", e))?;
    let mut atom = parse_session(&raw, &stem).map_err(|e| format!("parse: {}", e))?;
    atom.source_mtime_nanos = src_nanos;
    let final_path = target_dir.join(format!("{}.md", sanitize_id(&atom.conversation_id)));
    fs::write(&final_path, render_atom(&atom))
        .map_err(|e| format!("write {}: {}", final_path.display(), e))?;
    Ok(true)
}

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
        "session".to_string()
    } else {
        trimmed
    }
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CodexRoot {
    /// Object with a `messages` array.
    Object {
        #[serde(default)]
        id: Option<String>,
        #[serde(default, rename = "session_id")]
        session_id: Option<String>,
        #[serde(default)]
        messages: Vec<CodexMessage>,
    },
    /// Bare list of messages (some Codex builds).
    Bare(Vec<CodexMessage>),
}

#[derive(Debug, Deserialize, Default)]
struct CodexMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "created_at")]
    created_at: Option<String>,
}

impl CodexMessage {
    fn body(&self) -> String {
        if let Some(t) = &self.text {
            return t.clone();
        }
        match &self.content {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => {
                let mut out = String::new();
                for item in items {
                    if let Some(s) = item.as_str() {
                        out.push_str(s);
                    } else if let Some(obj) = item.as_object() {
                        if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                            out.push_str(t);
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
        self.timestamp.clone().or_else(|| self.created_at.clone())
    }
}

/// Parse a Codex session file. Tries JSON first, then falls back to
/// JSONL (one event per line — same shape as the Claude Code adapter).
pub fn parse_session(raw: &str, default_id: &str) -> Result<PersonalAgentAtom, String> {
    if let Ok(root) = serde_json::from_str::<CodexRoot>(raw) {
        return parse_root(root, default_id);
    }
    // JSONL fallback.
    let mut messages: Vec<CodexMessage> = Vec::new();
    let mut session_id: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if session_id.is_none() {
                if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
                    session_id = Some(id.to_string());
                } else if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                    session_id = Some(id.to_string());
                }
            }
            if let Ok(m) = serde_json::from_value::<CodexMessage>(value.clone()) {
                if m.role.is_some() || m.content.is_some() || m.text.is_some() {
                    messages.push(m);
                }
            }
        }
    }
    parse_root(
        CodexRoot::Object {
            id: session_id,
            session_id: None,
            messages,
        },
        default_id,
    )
}

fn parse_root(root: CodexRoot, default_id: &str) -> Result<PersonalAgentAtom, String> {
    let (id_opt, messages) = match root {
        CodexRoot::Object {
            id,
            session_id,
            messages,
        } => (id.or(session_id), messages),
        CodexRoot::Bare(messages) => (None, messages),
    };
    if messages.is_empty() {
        return Err("no messages in session".to_string());
    }
    let conversation_id = id_opt.unwrap_or_else(|| default_id.to_string());
    let topic = messages
        .iter()
        .find(|m| m.role.as_deref() == Some("user"))
        .or_else(|| messages.first())
        .map(|m| topic_from_first_message(&m.body()))
        .unwrap_or_default();
    let started_at = messages.iter().filter_map(|m| m.ts()).next();
    let ended_at = messages.iter().filter_map(|m| m.ts()).last();
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
            format!("**{}**: {}\n", role, text.trim_end())
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(PersonalAgentAtom {
        source: "codex".to_string(),
        conversation_id,
        started_at,
        ended_at,
        message_count: messages.len(),
        topic,
        source_mtime_nanos: 0,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_object_shape() {
        let raw = r#"{
            "session_id": "sess-1",
            "messages": [
                {"role": "user", "content": "hi", "timestamp": "2026-04-26T10:00:00Z"},
                {"role": "assistant", "content": "hello", "timestamp": "2026-04-26T10:00:01Z"}
            ]
        }"#;
        let a = parse_session(raw, "fallback").unwrap();
        assert_eq!(a.conversation_id, "sess-1");
        assert_eq!(a.message_count, 2);
        assert!(a.body.contains("**User**: hi"));
        assert!(a.body.contains("**Assistant**: hello"));
    }

    #[test]
    fn parses_jsonl_fallback() {
        let raw = "{\"role\":\"user\",\"content\":\"hi\"}\n\
{\"role\":\"assistant\",\"content\":\"yo\"}\n";
        let a = parse_session(raw, "stem-id").unwrap();
        assert_eq!(a.conversation_id, "stem-id");
        assert_eq!(a.message_count, 2);
    }

    #[test]
    fn rejects_empty_session() {
        let raw = r#"{"messages": []}"#;
        assert!(parse_session(raw, "x").is_err());
    }

    // === v1.15.2 fix #2 ===
    #[test]
    #[cfg(target_os = "windows")]
    fn codex_home_windows_resolves_to_appdata_codex_sessions() {
        let p = codex_home();
        let s = p.to_string_lossy().to_lowercase();
        assert!(
            s.contains("appdata") || s.contains("roaming"),
            "Windows codex_home must point under %APPDATA%, got {}",
            p.display()
        );
        assert!(
            s.ends_with("codex\\sessions") || s.ends_with("codex/sessions"),
            "Windows codex_home must end with Codex\\sessions, got {}",
            p.display()
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn codex_home_macos_resolves_to_dot_config_openai_sessions() {
        let p = codex_home();
        let s = p.to_string_lossy();
        assert!(
            s.ends_with(".config/openai/sessions"),
            "macOS codex_home must use ~/.config/openai/sessions, got {}",
            p.display()
        );
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    fn codex_home_linux_resolves_to_dot_config_openai_sessions() {
        let p = codex_home();
        let s = p.to_string_lossy();
        assert!(
            s.ends_with(".config/openai/sessions"),
            "Linux codex_home must use ~/.config/openai/sessions, got {}",
            p.display()
        );
    }
    // === end v1.15.2 fix #2 ===
}
