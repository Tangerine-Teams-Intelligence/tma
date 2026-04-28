//! v3.0 §1.9 — Replit Agent capture.
//!
//! Replit Agent runs in the cloud; like Devin we never tail a local
//! file. Capture path: REST poll against
//! `https://replit.com/api/v0/agents/recent` (the URL the Wave 2 brief
//! anchors on — Replit's actual endpoint may evolve, the adapter is
//! versioned so a schema change becomes a single point-edit). Auth is a
//! per-user API token kept in OS keychain by the daemon agent and
//! handed to this module by argument.
//!
//! **Stub default.** With no token the [`poll_recent`] entry returns an
//! empty result — no network, no errors. With a token but no live
//! network access (or the Wave 2 acceptance gate that says "DO NOT make
//! real calls") the poll records a single informational error so the
//! Settings UI can render "configured but offline" without misleading
//! the user.
//!
//! Atom path: `<dest_root>/replit/{session-id}.md`. Frontmatter shape
//! matches the Cursor adapter — same body shape (User: / Assistant:
//! turns), same idempotence rule (mtime nanos derived from the
//! payload's `updated_at` when present, else wall clock).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Per-user Replit connection settings.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ReplitConfig {
    /// Replit REST API token. Empty ⇒ stub mode (no API call).
    #[serde(default)]
    pub api_token: String,
}

impl ReplitConfig {
    pub fn is_stub(&self) -> bool {
        self.api_token.trim().is_empty()
    }
}

/// One agent session as returned by the Replit API. Permissive — the
/// real endpoint shape may shift as the product evolves; missing fields
/// fall back to defaults rather than fail the whole sweep.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReplitSession {
    /// Session identifier — required for atom keying.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Alternate field name used in some Replit responses.
    #[serde(default)]
    pub id: Option<String>,
    /// Human-readable task / repl name.
    #[serde(default)]
    pub title: Option<String>,
    /// Replit project / repl id.
    #[serde(default)]
    pub repl_id: Option<String>,
    /// RFC 3339 timestamp of last activity. Drives idempotence.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// RFC 3339 timestamp of session creation.
    #[serde(default)]
    pub started_at: Option<String>,
    /// Conversation turns. Empty list ⇒ atom body becomes a single
    /// summary line keyed off `title` / `repl_id`.
    #[serde(default)]
    pub messages: Vec<ReplitMessage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReplitMessage {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

/// Top-level response shape — `{"agents": [...]}` or a bare array.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ReplitListResponse {
    Wrapped {
        #[serde(default)]
        agents: Vec<ReplitSession>,
    },
    Bare(Vec<ReplitSession>),
}

impl ReplitListResponse {
    pub fn into_sessions(self) -> Vec<ReplitSession> {
        match self {
            ReplitListResponse::Wrapped { agents } => agents,
            ReplitListResponse::Bare(v) => v,
        }
    }
}

pub fn replit_dir(dest_root: &Path) -> PathBuf {
    dest_root.join("replit")
}

pub fn detected(dest_root: &Path) -> bool {
    let dir = replit_dir(dest_root);
    match fs::read_dir(&dir) {
        Ok(mut iter) => iter.any(|e| {
            e.ok()
                .map(|d| {
                    d.path().is_file()
                        && d.path()
                            .extension()
                            .map(|ex| ex.eq_ignore_ascii_case("md"))
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        }),
        Err(_) => false,
    }
}

// === v1.14.5 round-6 ===
/// Structured detection. Same shape as Devin — RemoteUnconfigured until
/// atoms land, then Installed. AccessDenied surfaces real perm errors
/// against the dest dir.
pub fn detection_status(dest_root: &Path) -> super::PersonalAgentDetectionStatus {
    super::probe_remote_dest(&replit_dir(dest_root))
}
// === end v1.14.5 round-6 ===

pub fn count_atoms(dest_root: &Path) -> usize {
    let dir = replit_dir(dest_root);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    entries
        .flatten()
        .filter(|e| {
            let p = e.path();
            p.is_file()
                && p.extension()
                    .map(|x| x.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
        })
        .count()
}

/// Stub-mode REST poll. Real HTTP fetch is held back per Wave 2 brief
/// (DO NOT make real Replit calls). This entry mirrors the Devin shape:
///
///   - no token ⇒ empty result, zero errors (silent no-op).
///   - token present but Wave 2 ⇒ empty result, single info-error so
///     the Settings UI can distinguish "configured" from "captured".
pub fn poll_recent(dest_root: &Path, config: &ReplitConfig) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("replit");
    let _ = fs::create_dir_all(replit_dir(dest_root));
    if config.is_stub() {
        return result;
    }
    result.errors.push(
        "replit REST poll not yet implemented (token configured; awaiting real-mode flag)"
            .to_string(),
    );
    result
}

/// Process a Replit API list response. Walks every session, writes one
/// atom each. Used by the (future) HTTP fetcher and the unit tests
/// directly.
pub fn process_list_response(
    dest_root: &Path,
    response: ReplitListResponse,
) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("replit");
    let target_dir = replit_dir(dest_root);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    for session in response.into_sessions() {
        match capture_one_session(&target_dir, &session) {
            Ok(true) => result.written += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => result.errors.push(e),
        }
    }
    result
}

fn capture_one_session(target_dir: &Path, session: &ReplitSession) -> Result<bool, String> {
    let session_id = session
        .session_id
        .clone()
        .or_else(|| session.id.clone())
        .ok_or_else(|| "missing session_id / id in response item".to_string())?;
    if session_id.trim().is_empty() {
        return Err("empty session_id".to_string());
    }

    let mtime_nanos = session
        .updated_at
        .as_deref()
        .and_then(parse_rfc3339_to_nanos)
        .unwrap_or_else(|| system_time_to_nanos(std::time::SystemTime::now()));

    let atom_path = target_dir.join(format!("{}.md", sanitize_id(&session_id)));
    if let Some(prev) = read_atom_source_mtime(&atom_path) {
        if prev >= mtime_nanos && mtime_nanos != 0 {
            return Ok(false);
        }
    }

    let topic = match session.title.as_deref() {
        Some(t) if !t.trim().is_empty() => topic_from_first_message(t),
        _ => {
            let from_messages = session
                .messages
                .iter()
                .find(|m| m.role.as_deref() == Some("user"))
                .or_else(|| session.messages.first())
                .map(|m| topic_from_first_message(m.content.as_deref().unwrap_or("")))
                .unwrap_or_default();
            if !from_messages.is_empty() {
                from_messages
            } else {
                topic_from_first_message(&format!("Replit session {}", session_id))
            }
        }
    };

    let body = if session.messages.is_empty() {
        let header = match (&session.title, &session.repl_id) {
            (Some(t), Some(r)) if !t.is_empty() && !r.is_empty() => {
                format!("**Replit session** `{}` — repl `{}`.\n", t, r)
            }
            (Some(t), _) if !t.is_empty() => format!("**Replit session** `{}`.\n", t),
            _ => format!("**Replit session** `{}`.\n", session_id),
        };
        header
    } else {
        session
            .messages
            .iter()
            .map(|m| {
                let role = match m.role.as_deref() {
                    Some("user") => "User",
                    Some("assistant") => "Assistant",
                    Some(other) => other,
                    None => "Message",
                };
                let body = m.content.clone().unwrap_or_default();
                format!("**{}**: {}\n", role, body.trim_end())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let started_at = session.started_at.clone().or_else(|| {
        session
            .messages
            .iter()
            .find_map(|m| m.timestamp.clone())
    });
    let ended_at = session.updated_at.clone().or_else(|| {
        session
            .messages
            .iter()
            .filter_map(|m| m.timestamp.clone())
            .last()
    });
    let message_count = session.messages.len().max(1);

    let atom = PersonalAgentAtom {
        source: "replit".to_string(),
        conversation_id: session_id,
        started_at,
        ended_at,
        message_count,
        topic,
        source_mtime_nanos: mtime_nanos,
        body,
    };

    fs::write(&atom_path, render_atom(&atom))
        .map_err(|e| format!("write {}: {}", atom_path.display(), e))?;
    Ok(true)
}

fn parse_rfc3339_to_nanos(s: &str) -> Option<u128> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_nanos_opt().unwrap_or(0).max(0) as u128)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_handles_empty_response() {
        // Empty wrapped + bare both yield zero atoms.
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_replit_empty_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let r1 = process_list_response(
            &tmp,
            ReplitListResponse::Wrapped { agents: Vec::new() },
        );
        assert_eq!(r1.written, 0);
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty());
        let r2 = process_list_response(&tmp, ReplitListResponse::Bare(Vec::new()));
        assert_eq!(r2.written, 0);
        assert_eq!(r2.skipped, 0);
        assert!(r2.errors.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn poll_recent_stub_mode_silent_noop() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_replit_stub_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = ReplitConfig::default();
        assert!(cfg.is_stub());
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn poll_recent_with_token_returns_pending_note() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_replit_token_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = ReplitConfig {
            api_token: "fake".to_string(),
        };
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        assert_eq!(result.errors.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn process_list_response_writes_one_atom_per_session() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_replit_two_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let response = ReplitListResponse::Wrapped {
            agents: vec![
                ReplitSession {
                    session_id: Some("s1".to_string()),
                    title: Some("debug auth".to_string()),
                    started_at: Some("2026-04-26T10:00:00Z".to_string()),
                    updated_at: Some("2026-04-26T10:30:00Z".to_string()),
                    messages: vec![ReplitMessage {
                        role: Some("user".to_string()),
                        content: Some("hi".to_string()),
                        timestamp: Some("2026-04-26T10:00:01Z".to_string()),
                    }],
                    ..Default::default()
                },
                ReplitSession {
                    session_id: Some("s2".to_string()),
                    title: Some("port scrape".to_string()),
                    updated_at: Some("2026-04-26T11:00:00Z".to_string()),
                    ..Default::default()
                },
            ],
        };
        let result = process_list_response(&tmp, response);
        assert_eq!(result.written, 2, "errors: {:?}", result.errors);
        assert!(result.errors.is_empty());
        let dir = replit_dir(&tmp);
        assert!(dir.join("s1.md").is_file());
        assert!(dir.join("s2.md").is_file());

        let body1 = fs::read_to_string(dir.join("s1.md")).unwrap();
        assert!(body1.contains("source: replit"));
        assert!(body1.contains("topic: debug auth"));
        assert!(body1.contains("**User**: hi"));

        let body2 = fs::read_to_string(dir.join("s2.md")).unwrap();
        assert!(body2.contains("**Replit session** `port scrape`"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_session_without_id() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_replit_noid_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let response = ReplitListResponse::Bare(vec![ReplitSession {
            title: Some("no-id".to_string()),
            ..Default::default()
        }]);
        let result = process_list_response(&tmp, response);
        assert_eq!(result.written, 0);
        assert_eq!(result.errors.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }
}
