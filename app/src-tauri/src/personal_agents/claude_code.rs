//! v3.0 §1.2 — Claude Code conversation capture.
//!
//! The Claude Code CLI / desktop client writes a JSONL file per session
//! under `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. Each
//! line is a JSON object — most are messages, some are queue/diagnostic
//! events we ignore. Schema (permissive):
//!
//! ```json
//! {"type":"user","message":{"role":"user","content":"..."},"timestamp":"...","sessionId":"..."}
//! {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"timestamp":"...","sessionId":"..."}
//! {"type":"queue-operation",...}    // ignored
//! {"type":"tool_use",...}            // ignored — we capture the user-visible turns
//! ```
//!
//! Atoms write one per session id, named after the session uuid. We walk
//! every project directory under `~/.claude/projects/` so multi-repo users
//! get every conversation in a single sweep. Idempotence is keyed on the
//! source `.jsonl`'s mtime nanos written into the atom frontmatter.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Resolve `~/.claude/projects/`. Returns the path even when missing.
pub fn claude_projects_root() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        return home.join(".claude").join("projects");
    }
    PathBuf::from(".claude").join("projects")
}

/// True when at least one `.jsonl` exists under any project dir.
pub fn detected() -> bool {
    let root = claude_projects_root();
    if !root.is_dir() {
        return false;
    }
    list_session_files(&root).is_empty().not()
}

// === v1.14.5 round-6 ===
/// Structured detection result — distinguishes "Claude Code not
/// installed" from "installed but ~/.claude/projects/ unreadable
/// (perms / network drive offline / file-not-dir)". The latter is the
/// trust-collapse case the R6 audit was scoped to surface.
pub fn detection_status() -> super::PersonalAgentDetectionStatus {
    super::probe_candidates(&[claude_projects_root()])
}
// === end v1.14.5 round-6 ===

/// Probe — count session JSONL files. Used by Settings detector.
pub fn count_conversations() -> usize {
    list_session_files(&claude_projects_root()).len()
}

/// Capture every Claude Code session into atoms under
/// `<dest_root>/claude-code/`.
pub fn capture(dest_root: &Path) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("claude-code");
    let target_dir = dest_root.join("claude-code");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    let root = claude_projects_root();
    if !root.is_dir() {
        return result;
    }
    for path in list_session_files(&root) {
        match capture_one_session(&path, &target_dir) {
            Ok(true) => result.written += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => result
                .errors
                .push(format!("{}: {}", path.display(), e)),
        }
    }
    result
}

/// Walk every project directory under `~/.claude/projects/` and collect
/// `*.jsonl` files. Two-level depth: project dirs at level 1, session
/// files at level 2 (Claude Code may also drop a session jsonl directly
/// at level 1 — we collect both).
fn list_session_files(root: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && has_jsonl_ext(&path) {
            out.push(path);
            continue;
        }
        if path.is_dir() {
            // One level deep — Claude Code writes session JSONLs as direct
            // children of each project dir.
            if let Ok(children) = fs::read_dir(&path) {
                for child in children.flatten() {
                    let cp = child.path();
                    if cp.is_file() && has_jsonl_ext(&cp) {
                        out.push(cp);
                    }
                }
            }
        }
    }
    out.sort();
    out
}

fn has_jsonl_ext(p: &Path) -> bool {
    p.extension()
        .map(|e| e.eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false)
}

/// Read one JSONL session file and write/refresh the atom. Returns
/// `Ok(true)` on write, `Ok(false)` when the atom is already up to date.
fn capture_one_session(src: &Path, target_dir: &Path) -> Result<bool, String> {
    let src_meta = fs::metadata(src).map_err(|e| format!("metadata: {}", e))?;
    let src_mtime = src_meta.modified().unwrap_or_else(|_| SystemTime::now());
    let src_nanos = system_time_to_nanos(src_mtime);
    // Default conversation id from filename so we can compare atom mtime
    // before reading the (potentially large) JSONL.
    let session_from_name = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    let atom_path_provisional = target_dir.join(format!("{}.md", sanitize_id(&session_from_name)));
    if let Some(prev) = read_atom_source_mtime(&atom_path_provisional) {
        if prev >= src_nanos {
            return Ok(false);
        }
    }
    let raw = fs::read_to_string(src).map_err(|e| format!("read: {}", e))?;
    let mut atom = parse_jsonl(&raw, &session_from_name).map_err(|e| format!("parse: {}", e))?;
    atom.source_mtime_nanos = src_nanos;
    // Re-resolve the path in case parse_jsonl picked a different
    // sessionId out of the file (when conversations are shared across
    // multiple jsonl files Claude Code keeps the same id, or when the
    // filename uuid disagrees with the in-file sessionId after a session
    // resume/fork — common on real CEO machines).
    let atom_path = target_dir.join(format!("{}.md", sanitize_id(&atom.conversation_id)));
    // Second idempotence check against the resolved path. Without this,
    // any session whose filename stem != in-file sessionId would re-write
    // every heartbeat (cheap but wastes disk + invalidates downstream
    // mtime-based caches). The provisional check above only catches files
    // where stem == sessionId.
    if atom_path != atom_path_provisional {
        if let Some(prev) = read_atom_source_mtime(&atom_path) {
            if prev >= src_nanos {
                return Ok(false);
            }
        }
    }
    let body = render_atom(&atom);
    fs::write(&atom_path, body.clone()).map_err(|e| format!("write {}: {}", atom_path.display(), e))?;
    // === wave 16 ===
    // Push onto the in-memory activity ring so the React `<ActivityFeed/>`
    // sees this conversation when it re-reads via `activity_recent`. We
    // intentionally use the no-emit variant here — the Tauri command
    // thunk that wraps `capture` walks the result + fires the
    // `activity:atom_written` event itself once it knows the count.
    let title = if atom.topic.is_empty() {
        atom.conversation_id.clone()
    } else {
        atom.topic.clone()
    };
    let rel = compute_rel_path(&atom_path);
    let ev = crate::activity::ActivityAtomEvent::new(
        rel.clone(),
        title,
        crate::activity::AtomKind::Thread,
    )
    .with_vendor("claude-code");
    crate::activity::push_event_to_ring(ev);
    // === end wave 16 ===
    // === wave 1.13-C ===
    // After successfully writing the atom, scan the body for mentions of
    // known team members and emit one inbox event per match. Best-effort:
    // a failure here never aborts the capture (the parser already wrote
    // the atom file). We fire-and-forget on the existing tokio runtime
    // so the regex scan + (rare, gated) LLM dispatch never block the
    // heartbeat. The current_user is parsed from the atom path itself
    // (.../personal/<user>/threads/...) so the parser doesn't need a
    // signature change. Feature flag respected via
    // `crate::agi::mention_extractor::is_enabled()`.
    wave1_13c_dispatch_extract(&atom_path, &rel, &atom.body, "claude-code");
    // === end wave 1.13-C ===
    Ok(true)
}

// === wave 1.13-C ===
/// Fire-and-forget mention extraction. Runs on the ambient tokio
/// runtime (the parser is invoked from `tauri::async_runtime::spawn_blocking`
/// in `commands::personal_agents`, so a runtime exists). When no runtime
/// is found (unit-test contexts), the call silently no-ops — the parser
/// tests don't depend on inbox emit succeeding.
fn wave1_13c_dispatch_extract(atom_path: &Path, rel_path: &str, body: &str, vendor: &str) {
    if body.trim().is_empty() {
        return;
    }
    if !crate::agi::mention_extractor::is_globally_enabled() {
        return;
    }
    let user = crate::agi::mention_extractor::user_from_atom_path(atom_path)
        .unwrap_or_else(|| "me".to_string());
    let atom_path_owned = atom_path.to_path_buf();
    let rel_owned = rel_path.to_string();
    let body_owned = body.to_string();
    let vendor_owned = vendor.to_string();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = crate::agi::mention_extractor::extract_and_emit(
                &atom_path_owned,
                &rel_owned,
                &body_owned,
                &user,
                &vendor_owned,
                crate::agi::mention_extractor::is_llm_enabled(),
            )
            .await;
        });
    }
}
// === end wave 1.13-C ===

// === wave 16 ===
/// Compute a memory-root-relative path from an absolute atom path. Best
/// effort: walks up looking for `.tangerine-memory`; falls back to the
/// last 4 components which still gives the React feed a usable string
/// (`personal/<user>/threads/claude-code/<id>.md`).
fn compute_rel_path(atom_path: &Path) -> String {
    let s = atom_path.to_string_lossy().replace('\\', "/");
    if let Some(idx) = s.find(".tangerine-memory/") {
        let rest = &s[idx + ".tangerine-memory/".len()..];
        return rest.to_string();
    }
    // Fallback — last 4 components.
    let parts: Vec<&str> = s.split('/').collect();
    let n = parts.len();
    if n >= 4 {
        parts[n - 4..].join("/")
    } else {
        s
    }
}
// === end wave 16 ===

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

#[derive(Debug, Deserialize, Default)]
struct ClaudeCodeEvent {
    #[serde(rename = "type", default)]
    type_field: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<ClaudeCodeMessage>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaudeCodeMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
}

impl ClaudeCodeMessage {
    fn body(&self) -> String {
        match &self.content {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => {
                // The newer assistant shape ships
                // `content: [{type:"text", text:"..."}, ...]`. Concat the
                // text chunks; ignore tool_use blocks.
                let mut out = String::new();
                for item in items {
                    if let Some(s) = item.as_str() {
                        out.push_str(s);
                    } else if let Some(obj) = item.as_object() {
                        if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                                out.push_str(text);
                            }
                        }
                    }
                }
                out
            }
            Some(other) => other.to_string(),
            None => String::new(),
        }
    }
}

/// Parse a session JSONL into a single atom. `default_session_id` is
/// used when the file's events don't carry one (rare — defensive).
pub fn parse_jsonl(raw: &str, default_session_id: &str) -> Result<PersonalAgentAtom, String> {
    let mut messages_by_role_ts: Vec<(String, Option<String>, String)> = Vec::new();
    let mut session_id: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    for (idx, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let ev: ClaudeCodeEvent = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue, // skip malformed lines, keep going
        };
        if session_id.is_none() {
            session_id = ev.session_id.clone();
        }
        let kind = ev.type_field.as_deref().unwrap_or("");
        // Only render user / assistant turns. queue-operation,
        // tool_use, tool_result, summary, etc. are diagnostic noise from
        // the user's perspective.
        if !matches!(kind, "user" | "assistant") {
            continue;
        }
        let msg = match ev.message {
            Some(m) => m,
            None => continue,
        };
        let role = msg
            .role
            .clone()
            .unwrap_or_else(|| kind.to_string());
        let body = msg.body();
        if body.trim().is_empty() {
            // Empty assistant turn (tool-only) — skip. Avoids stranded
            // "**Assistant**: " bullets in the rendered atom.
            continue;
        }
        if started_at.is_none() {
            started_at = ev.timestamp.clone();
        }
        if ev.timestamp.is_some() {
            ended_at = ev.timestamp.clone();
        }
        messages_by_role_ts.push((role, ev.timestamp, body));
        // Defensive: skip absurdly large files (> 50k events) — the
        // user's real session never gets that long. Avoids OOM if a log
        // got corrupted.
        if idx > 50_000 {
            break;
        }
    }
    if messages_by_role_ts.is_empty() {
        return Err("no user/assistant messages in session".to_string());
    }
    // Sort by timestamp when present so out-of-order events still render
    // chronologically. Events with no timestamp keep their original order
    // via the stable sort.
    let mut indexed: BTreeMap<usize, (String, Option<String>, String)> = BTreeMap::new();
    for (i, m) in messages_by_role_ts.into_iter().enumerate() {
        indexed.insert(i, m);
    }
    let mut messages: Vec<(String, Option<String>, String)> = indexed.into_values().collect();
    messages.sort_by(|a, b| match (&a.1, &b.1) {
        (Some(ta), Some(tb)) => ta.cmp(tb),
        _ => std::cmp::Ordering::Equal,
    });
    let conversation_id = session_id.unwrap_or_else(|| default_session_id.to_string());
    let topic = messages
        .iter()
        .find(|m| m.0 == "user")
        .map(|m| topic_from_first_message(&m.2))
        .unwrap_or_default();
    let body = messages
        .iter()
        .map(|(role, _ts, text)| {
            let label = match role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                other => other,
            };
            format!("**{}**: {}\n", label, text.trim_end())
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(PersonalAgentAtom {
        source: "claude-code".to_string(),
        conversation_id,
        started_at,
        ended_at,
        message_count: messages.len(),
        topic,
        source_mtime_nanos: 0,
        body,
    })
}

// --------------------------------------------------------------------------
// Tiny shim — `bool::not` isn't auto-imported in older toolchains.
// --------------------------------------------------------------------------
trait BoolNot {
    fn not(self) -> bool;
}
impl BoolNot for bool {
    fn not(self) -> bool {
        !self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> &'static str {
        // Mirrors the actual shape we observed in
        // `~/.claude/projects/.../*.jsonl`.
        "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"timestamp\":\"2026-04-26T10:00:00Z\",\"sessionId\":\"abc-123\"}\n\
{\"type\":\"user\",\"sessionId\":\"abc-123\",\"timestamp\":\"2026-04-26T10:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n\
{\"type\":\"assistant\",\"sessionId\":\"abc-123\",\"timestamp\":\"2026-04-26T10:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hi there\"}]}}\n\
{\"type\":\"tool_use\",\"sessionId\":\"abc-123\",\"timestamp\":\"2026-04-26T10:00:03Z\"}\n"
    }

    #[test]
    fn parses_jsonl_into_atom() {
        let atom = parse_jsonl(fixture(), "fallback").unwrap();
        assert_eq!(atom.conversation_id, "abc-123");
        assert_eq!(atom.message_count, 2);
        assert!(atom.body.contains("**User**: hello"));
        assert!(atom.body.contains("**Assistant**: hi there"));
        assert_eq!(atom.started_at.as_deref(), Some("2026-04-26T10:00:01Z"));
        assert_eq!(atom.ended_at.as_deref(), Some("2026-04-26T10:00:02Z"));
        assert_eq!(atom.topic, "hello");
    }

    #[test]
    fn skips_malformed_lines_keeps_going() {
        let raw = "not json at all\n\
{\"type\":\"user\",\"sessionId\":\"x\",\"message\":{\"role\":\"user\",\"content\":\"after garbage\"}}\n";
        let atom = parse_jsonl(raw, "fallback").unwrap();
        assert_eq!(atom.message_count, 1);
        assert!(atom.body.contains("after garbage"));
    }

    #[test]
    fn rejects_session_with_no_messages() {
        let raw = "{\"type\":\"queue-operation\",\"sessionId\":\"x\"}\n";
        assert!(parse_jsonl(raw, "fallback").is_err());
    }

    #[test]
    fn capture_one_session_idempotent() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_cc_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let src_dir = tmp.join("src");
        let target_dir = tmp.join("dest").join("claude-code");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let src_file = src_dir.join("abc-123.jsonl");
        fs::write(&src_file, fixture()).unwrap();
        let first = capture_one_session(&src_file, &target_dir).unwrap();
        assert!(first);
        let second = capture_one_session(&src_file, &target_dir).unwrap();
        assert!(!second);
        // Atom file actually exists.
        assert!(target_dir.join("abc-123.md").is_file());
        let _ = fs::remove_dir_all(&tmp);
    }
}
