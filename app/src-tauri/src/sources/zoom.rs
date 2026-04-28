// === wave 1.13-E ===
//! v1.13 Agent E — Zoom source connector (cloud-recording transcripts).
//!
//! Distinct from `commands::zoom` (Phase 2-C) which is the writeback /
//! capture surface for Server-to-Server OAuth-keyed account-wide queries.
//! This module is the **personal-vault** capture: it reads the user's own
//! cloud recordings (OAuth user-context with `recording:read` +
//! `meeting:read` scopes) and writes one atom per meeting under
//! `<memory_root>/personal/<user>/threads/zoom/<meeting_uuid>.md`.
//!
//! Auth model
//! ==========
//! User-context OAuth (NOT Server-to-Server). The chat-driven setup flow
//! (see `commands::onboarding_chat::execute_setup_source_zoom`) walks the
//! user through Zoom's OAuth marketplace install, captures the resulting
//! `access_token` + `refresh_token` + `expires_at`, and stores them via
//! `secret_store::secret_store_set_oauth` keyed under
//! `tangerine.source.zoom.<account>`.
//!
//! Polling cadence
//! ===============
//! Default 5 minutes. Cloud recordings are processed asynchronously by Zoom
//! after the meeting ends — a tighter loop wastes API quota.
//!
//! Atom format
//! ===========
//! Frontmatter:
//!   source: zoom
//!   meeting_uuid: <Zoom uuid>
//!   topic: <meeting topic>
//!   host: <host display name>
//!   duration_min: <int>
//!   ts: <RFC3339 meeting start>
//!   attendees: [a, b, c]
//! Body: full transcript (chronological), one paragraph per speaker turn.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ZoomConfig {
    /// Account alias (free-form). Used as the keyring secondary key.
    #[serde(default)]
    pub account_alias: String,
    /// Zoom API base — defaults to `https://api.zoom.us/v2`.
    #[serde(default = "default_zoom_base")]
    pub api_base: String,
    /// Polling cadence in minutes. Min 5 (anything tighter blows the quota).
    #[serde(default = "default_poll_minutes")]
    pub poll_interval_minutes: u32,
    #[serde(default)]
    pub enabled: bool,
}

fn default_zoom_base() -> String {
    "https://api.zoom.us/v2".to_string()
}

fn default_poll_minutes() -> u32 {
    5
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ZoomFetchResult {
    pub atoms_written: u32,
    pub items_seen: u32,
    pub errors: Vec<String>,
}

/// Borrowed shape passed to the pure renderer.
#[derive(Debug, Clone)]
pub struct ZoomMeetingAtom<'a> {
    pub meeting_uuid: &'a str,
    pub topic: &'a str,
    pub host: &'a str,
    pub duration_minutes: u32,
    pub start_ts: DateTime<Utc>,
    pub attendees: &'a [String],
    pub transcript: &'a str,
}

pub fn format_zoom_atom(input: &ZoomMeetingAtom<'_>) -> String {
    let attendees_yaml = if input.attendees.is_empty() {
        "[]".to_string()
    } else {
        format!(
            "[{}]",
            input
                .attendees
                .iter()
                .map(|a| yaml_scalar(a))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "---\n\
source: zoom\n\
meeting_uuid: {meeting_uuid}\n\
topic: {topic}\n\
host: {host}\n\
duration_min: {duration_minutes}\n\
ts: {ts}\n\
attendees: {attendees_yaml}\n\
captured_by: tangerine-zoom-source\n\
---\n\
\n\
{transcript}\n",
        meeting_uuid = yaml_scalar(input.meeting_uuid),
        topic = yaml_scalar(input.topic),
        host = yaml_scalar(input.host),
        duration_minutes = input.duration_minutes,
        ts = input.start_ts.to_rfc3339(),
        attendees_yaml = attendees_yaml,
        transcript = input.transcript.trim(),
    )
}

pub fn meeting_filename(uuid: &str) -> String {
    let cleaned: String = uuid
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "unknown.md".to_string()
    } else {
        format!("{cleaned}.md")
    }
}

pub fn resolve_zoom_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads")
        .join("zoom")
}

pub async fn ingest_tick_stub(cfg: &ZoomConfig) -> ZoomFetchResult {
    if !cfg.enabled {
        return ZoomFetchResult {
            errors: vec!["zoom source disabled".to_string()],
            ..Default::default()
        };
    }
    // Real flow:
    //   1. Resolve OAuth access token from secret_store. Refresh via
    //      POST https://zoom.us/oauth/token if expires_at is past.
    //   2. GET /users/me/recordings?from=<lookback> to enumerate recent
    //      cloud recordings.
    //   3. For each recording, GET /meetings/{meetingId}/recordings to
    //      pull the transcript file URL, then GET that URL with the
    //      same Bearer token.
    //   4. Format with format_zoom_atom and write to resolve_zoom_dir.
    ZoomFetchResult::default()
}

fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.starts_with('-')
        || s.starts_with(' ')
        || s.ends_with(' ');
    if needs_quote {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-04-27T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn atom_renders_attendees_and_transcript() {
        let atts = vec!["Alice".to_string(), "Bob".to_string()];
        let atom = format_zoom_atom(&ZoomMeetingAtom {
            meeting_uuid: "abc==xyz",
            topic: "Standup",
            host: "Daizhe",
            duration_minutes: 30,
            start_ts: ts(),
            attendees: &atts,
            transcript: "Alice: hi.\nBob: hi.",
        });
        assert!(atom.contains("source: zoom"));
        assert!(atom.contains("topic: Standup"));
        assert!(atom.contains("Alice"));
        assert!(atom.contains("duration_min: 30"));
        assert!(atom.contains("attendees: ["));
    }

    #[test]
    fn filename_strips_special_chars() {
        let f = meeting_filename("abc==xyz/../etc");
        assert!(!f.contains('/'));
        assert!(!f.contains('='));
        assert!(f.ends_with(".md"));
    }

    #[test]
    fn empty_attendees_renders_empty_array() {
        let empty: Vec<String> = Vec::new();
        let atom = format_zoom_atom(&ZoomMeetingAtom {
            meeting_uuid: "u",
            topic: "T",
            host: "H",
            duration_minutes: 0,
            start_ts: ts(),
            attendees: &empty,
            transcript: "",
        });
        assert!(atom.contains("attendees: []"));
    }

    #[test]
    fn dir_routes_under_personal_threads_zoom() {
        let p = resolve_zoom_dir(Path::new("/tmp/m"), "alice");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/zoom"), "got {s}");
    }

    #[test]
    fn ingest_disabled_reports_error_not_panic() {
        let cfg = ZoomConfig::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let r = rt.block_on(ingest_tick_stub(&cfg));
        assert_eq!(r.atoms_written, 0);
        assert!(!r.errors.is_empty());
    }
}
// === end wave 1.13-E ===
