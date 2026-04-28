//! v3.0 §1 — Personal AI agent capture.
//!
//! Reads the user's local AI agent conversation logs (Cursor, Claude Code,
//! Codex, Windsurf) and writes one atom per conversation into
//! `personal/<user>/threads/<agent>/<conversation-id>.md`.
//!
//! **Strict opt-in.** Every adapter is gated behind a per-source toggle
//! (`personalAgentsEnabled.{cursor,claude_code,codex,windsurf}`) that
//! defaults to `false`. The daemon hook (`crate::daemon::do_heartbeat`) only
//! invokes an adapter when its toggle is on AND the source's home directory
//! exists on disk. A fresh install where the user has never enabled any
//! agent costs nothing per heartbeat.
//!
//! **Idempotence rule.** Each adapter checks the atom file's mtime + the
//! conversation source file's mtime; if the atom is newer or equal, the
//! adapter skips that conversation. Re-running the scan over a stable log
//! dir is a no-op.
//!
//! Privacy: §5.2 v3.0 — `personal/` is git-ignored at the memory root.
//! These atoms never leave the user's machine. The "promote to team" flow
//! is its own surface; this module never copies anything into `team/`.
//!
//! Sub-modules:
//!   * `cursor` — `~/.cursor/conversations/*.json`
//!   * `claude_code` — `~/.claude/projects/<slug>/<uuid>.jsonl`
//!   * `codex` — `~/.config/openai/sessions/*` (best-effort path probe)
//!   * `windsurf` — best-effort, mirrors Cursor adapter under Windsurf's
//!     own conversations dir
//!
//! All four adapters are read-only against the source directory. We never
//! write back to a source's own log path.

pub mod cursor;
pub mod claude_code;
pub mod codex;
pub mod windsurf;

// === v3.0 wave 2 personal agents ===
// v3.0 wave 2 adds remote-source agents (Devin, Replit, Apple Intelligence,
// MS Copilot personal). Each module is strict opt-in (default off in
// `personal_agents.json`) and ships in stub mode for the cloud-API ones —
// the real network fetch lands when a customer with an actual license/token
// flips a single feature flag. Wave 1 sources stay file-tail based.
pub mod devin;
pub mod replit;
pub mod apple_intelligence;
pub mod ms_copilot;
// === end v3.0 wave 2 personal agents ===

use serde::{Deserialize, Serialize};

/// Source identifier — used for the atom subdirectory name and the
/// per-source toggle key. String form so we can extend the set in v3.0
/// later phases (claude_ai, chatgpt, gemini, devin, replit, ...) without a
/// schema bump.
pub fn agent_id(source: PersonalAgentSource) -> &'static str {
    match source {
        PersonalAgentSource::Cursor => "cursor",
        PersonalAgentSource::ClaudeCode => "claude-code",
        PersonalAgentSource::Codex => "codex",
        PersonalAgentSource::Windsurf => "windsurf",
    }
}

/// Every source we currently support in the v3.0 alpha-1 slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersonalAgentSource {
    Cursor,
    ClaudeCode,
    Codex,
    Windsurf,
}

impl PersonalAgentSource {
    pub fn all() -> &'static [PersonalAgentSource] {
        &[
            PersonalAgentSource::Cursor,
            PersonalAgentSource::ClaudeCode,
            PersonalAgentSource::Codex,
            PersonalAgentSource::Windsurf,
        ]
    }
}

/// In-memory atom representation produced by every adapter. Adapters render
/// this to the on-disk markdown body via [`render_atom`]; the renderer is
/// shared so frontmatter shape stays consistent across sources.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersonalAgentAtom {
    pub source: String,
    pub conversation_id: String,
    /// RFC 3339 timestamp of the first message we saw for this conversation.
    pub started_at: Option<String>,
    /// RFC 3339 timestamp of the most recent message we saw.
    pub ended_at: Option<String>,
    pub message_count: usize,
    /// Best-effort topic — the first user message, capped at 80 chars. Empty
    /// when the conversation has no user-role message we can read.
    pub topic: String,
    /// Source file mtime as nanos-since-epoch — encoded into the atom's
    /// frontmatter (`source_mtime_nanos:`) so a follow-up scan can compare
    /// it against the live source mtime and skip the rewrite when nothing
    /// changed. Avoids a `filetime` dep — we just round-trip an integer.
    pub source_mtime_nanos: u128,
    /// Pre-rendered markdown body (User: / Assistant: chunks). Adapters
    /// build this directly so each source's role mapping stays self-contained.
    pub body: String,
}

/// Per-source summary returned by `personal_agents_scan_all` so the
/// Settings UI can show "found N conversations" without writing anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalAgentSummary {
    pub source: String,
    /// True when the source's home directory exists on this machine.
    /// Kept for back-compat with the existing TS bindings; new UI code
    /// should prefer the richer `status` field which distinguishes
    /// "not installed" from "permission denied" / "platform unsupported".
    pub detected: bool,
    /// Absolute path to the source's home directory (even when missing —
    /// used by the Settings UI to render "Looking for X at <path>").
    pub home_path: String,
    /// Number of conversation source files found. 0 when not detected.
    pub conversation_count: usize,
    // === v1.14.5 round-6 ===
    /// Structured detection result. New in R6 — surfaces the difference
    /// between "we never installed Cursor" (silent grey dot) and "Cursor
    /// is installed but we can't read its conversation dir" (loud
    /// permission warning). Defaults to a value derived from `detected`
    /// for sources that haven't migrated yet, so legacy callers never
    /// crash.
    #[serde(default)]
    pub status: PersonalAgentDetectionStatus,
    // === end v1.14.5 round-6 ===
}

// === v1.14.5 round-6 ===
/// Structured detection result. Replaces the bare `detected: bool`
/// pattern that masked permission errors as "not installed". The
/// per-source `detection_status()` returns this; the Settings UI renders
/// each variant with a distinct icon + tooltip so the user can tell
/// "Cursor isn't installed on this machine" from "Cursor IS installed
/// but Tangerine can't read its conversation dir — fix the perms".
///
/// Serializes as a tagged union: `{"kind":"installed", ...}`. The TS
/// side narrows on `kind` for the per-row badge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PersonalAgentDetectionStatus {
    /// Source's home dir is on disk + readable. The happy path.
    Installed,
    /// Source's home dir doesn't exist on disk. Most common state — the
    /// user just hasn't installed Cursor / Codex / etc on this machine.
    /// Settings UI shows a grey dot + "Looking for X at <path>".
    NotInstalled,
    /// Source's home dir exists but we can't read it (permission denied,
    /// path is a file not a dir, network drive offline, ...). The user
    /// IS using the source but Tangerine isn't capturing — this is the
    /// trust-collapse case the R6 audit was scoped to surface. UI
    /// renders an amber warning + the OS error message.
    AccessDenied { reason: String },
    /// Source needs a platform we're not on (Apple Intelligence on
    /// non-macOS, MS Copilot's enterprise license required, ...). UI
    /// renders a neutral "not supported on this platform" line.
    PlatformUnsupported { reason: String },
    /// Source is remote-only (Devin / Replit / MS Copilot / Apple
    /// Intelligence post-action) and depends on tokens / webhooks that
    /// aren't configured yet. UI renders "configured but no captures
    /// yet" — distinguishes from `NotInstalled` because the source
    /// can't be "installed" locally in the first place.
    RemoteUnconfigured,
}

impl Default for PersonalAgentDetectionStatus {
    fn default() -> Self {
        // Conservative default — pre-R6 callers that don't set this field
        // get the "not installed" rendering, matching the old `detected:
        // false` UI.
        PersonalAgentDetectionStatus::NotInstalled
    }
}

impl PersonalAgentDetectionStatus {
    /// True for the happy path. Used by the legacy `detected` mirror so
    /// the bool field stays in lockstep with the new tagged enum.
    pub fn is_installed(&self) -> bool {
        matches!(self, PersonalAgentDetectionStatus::Installed)
    }
}

/// Probe a source's home directory and return a structured detection
/// result. Used by every adapter's `detection_status()` helper so they
/// share one access-denied recovery path. The probe is read-only.
pub fn probe_local_dir(dir: &std::path::Path) -> PersonalAgentDetectionStatus {
    match std::fs::read_dir(dir) {
        Ok(_) => PersonalAgentDetectionStatus::Installed,
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => PersonalAgentDetectionStatus::NotInstalled,
            std::io::ErrorKind::PermissionDenied => {
                PersonalAgentDetectionStatus::AccessDenied {
                    reason: format!("permission denied: {}", e),
                }
            }
            // NotADirectory + every other I/O error class still means
            // "we can't read this" — surface as access denied so the
            // user sees the OS message instead of a silent grey dot.
            _ => PersonalAgentDetectionStatus::AccessDenied {
                reason: format!("{}", e),
            },
        },
    }
}

/// Probe a list of candidate directories and return the most-informative
/// status. An `Installed` short-circuits; an `AccessDenied` wins over
/// every `NotInstalled` so the user sees the trust-collapse case (source
/// IS installed but unreadable) instead of a silent "not installed" dot.
/// Falls back to `NotInstalled` only when every candidate is genuinely
/// missing.
pub fn probe_candidates(dirs: &[std::path::PathBuf]) -> PersonalAgentDetectionStatus {
    let mut access_denied: Option<PersonalAgentDetectionStatus> = None;
    for dir in dirs {
        match probe_local_dir(dir) {
            PersonalAgentDetectionStatus::Installed => {
                return PersonalAgentDetectionStatus::Installed;
            }
            PersonalAgentDetectionStatus::NotInstalled => {}
            other => {
                if access_denied.is_none() {
                    access_denied = Some(other);
                }
            }
        }
    }
    access_denied.unwrap_or(PersonalAgentDetectionStatus::NotInstalled)
}

/// Remote-source detection helper. Devin / Replit / MS Copilot have no
/// local install path; the existence of at least one captured atom in
/// the dest dir flips them to `Installed`, otherwise `RemoteUnconfigured`.
/// Permission errors against the dest dir surface as `AccessDenied` —
/// that's almost always a misconfigured `~/.tangerine-memory/` path.
pub fn probe_remote_dest(dest_dir: &std::path::Path) -> PersonalAgentDetectionStatus {
    match std::fs::read_dir(dest_dir) {
        Ok(iter) => {
            let has_md = iter
                .filter_map(Result::ok)
                .any(|e| {
                    let p = e.path();
                    p.is_file()
                        && p.extension()
                            .map(|ex| ex.eq_ignore_ascii_case("md"))
                            .unwrap_or(false)
                });
            if has_md {
                PersonalAgentDetectionStatus::Installed
            } else {
                PersonalAgentDetectionStatus::RemoteUnconfigured
            }
        }
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => PersonalAgentDetectionStatus::RemoteUnconfigured,
            std::io::ErrorKind::PermissionDenied => PersonalAgentDetectionStatus::AccessDenied {
                reason: format!("permission denied: {}", e),
            },
            _ => PersonalAgentDetectionStatus::AccessDenied {
                reason: format!("{}", e),
            },
        },
    }
}
// === end v1.14.5 round-6 ===

/// Per-source capture outcome — one entry per agent run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalAgentCaptureResult {
    pub source: String,
    /// Number of atom files written or refreshed during this capture.
    pub written: usize,
    /// Number of conversations skipped because the on-disk atom was up to
    /// date.
    pub skipped: usize,
    /// Errors encountered per conversation. Best-effort — one bad file
    /// never aborts the whole sweep.
    pub errors: Vec<String>,
}

impl PersonalAgentCaptureResult {
    pub fn empty(source: &str) -> Self {
        Self {
            source: source.to_string(),
            written: 0,
            skipped: 0,
            errors: Vec::new(),
        }
    }
}

/// Render a [`PersonalAgentAtom`] to the markdown text we persist on disk.
/// Pure function — the adapters call this so the frontmatter shape stays
/// in lockstep across sources. Tests assert on the output directly.
pub fn render_atom(atom: &PersonalAgentAtom) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("source: {}\n", atom.source));
    out.push_str(&format!(
        "conversation_id: {}\n",
        yaml_scalar(&atom.conversation_id)
    ));
    if let Some(ts) = &atom.started_at {
        out.push_str(&format!("started_at: {}\n", ts));
    }
    if let Some(ts) = &atom.ended_at {
        out.push_str(&format!("ended_at: {}\n", ts));
    }
    out.push_str(&format!("message_count: {}\n", atom.message_count));
    out.push_str(&format!(
        "source_mtime_nanos: {}\n",
        atom.source_mtime_nanos
    ));
    if !atom.topic.is_empty() {
        out.push_str(&format!("topic: {}\n", yaml_scalar(&atom.topic)));
    }
    out.push_str("---\n\n");
    let title = if atom.topic.is_empty() {
        atom.conversation_id.as_str()
    } else {
        atom.topic.as_str()
    };
    out.push_str(&format!("# {}\n\n", title));
    if atom.body.trim().is_empty() {
        out.push_str("_(empty conversation)_\n");
    } else {
        out.push_str(atom.body.trim_end());
        out.push('\n');
    }
    out
}

/// Public re-export of [`yaml_scalar`] for wave 2 adapters that splice
/// extra frontmatter lines (Devin / Apple Intelligence / MS Copilot
/// `*_extras` renderers). Keeping the actual implementation private
/// avoids accidental misuse from outside the crate while still letting
/// sibling adapters reuse the same quoting rule.
pub fn yaml_scalar_pub(s: &str) -> String {
    yaml_scalar(s)
}

/// Quote a YAML scalar when it contains structural characters. Same shape
/// as `sources::voice_notes::yaml_scalar`.
fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.contains('"');
    if needs_quote {
        let escaped = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

/// Read the `source_mtime_nanos` frontmatter field out of an atom file.
/// Returns `None` when the file is missing, has no frontmatter, or the
/// field is absent. Used by every adapter to decide whether a re-write
/// is needed without depending on the on-disk file's own mtime (which
/// some filesystems quantize to the second).
pub fn read_atom_source_mtime(path: &std::path::Path) -> Option<u128> {
    let raw = std::fs::read_to_string(path).ok()?;
    let head = raw.trim_start_matches('\u{feff}');
    let head = head.strip_prefix("---")?.strip_prefix('\n')?;
    let close = head
        .find("\n---\n")
        .or_else(|| head.find("\n---\r\n"))
        .or_else(|| {
            if head.ends_with("\n---") {
                Some(head.len() - 4)
            } else {
                None
            }
        })?;
    let block = &head[..close];
    for line in block.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("source_mtime_nanos:") {
            return rest.trim().parse::<u128>().ok();
        }
    }
    None
}

/// Convert a `SystemTime` into nanos-since-Unix-epoch. Pre-epoch instants
/// (which shouldn't happen on a modern fs but guard anyway) collapse to 0.
pub fn system_time_to_nanos(t: std::time::SystemTime) -> u128 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Cap a topic string to a sensible frontmatter length. Strips newlines so
/// the YAML stays single-line.
pub fn topic_from_first_message(text: &str) -> String {
    const MAX: usize = 80;
    let collapsed: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let trimmed = collapsed.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let mut buf = String::new();
    let mut count = 0usize;
    for c in trimmed.chars() {
        if count >= MAX - 1 {
            break;
        }
        buf.push(c);
        count += 1;
    }
    buf.push('…');
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_atom_preserves_shape() {
        let atom = PersonalAgentAtom {
            source: "cursor".to_string(),
            conversation_id: "abc-123".to_string(),
            started_at: Some("2026-04-26T10:00:00+00:00".to_string()),
            ended_at: Some("2026-04-26T10:30:00+00:00".to_string()),
            message_count: 4,
            topic: "patent v7 review".to_string(),
            source_mtime_nanos: 1234567890,
            body: "User: hi\n\nAssistant: hello\n".to_string(),
        };
        let s = render_atom(&atom);
        assert!(s.starts_with("---\n"));
        assert!(s.contains("source: cursor\n"));
        assert!(s.contains("conversation_id: abc-123\n"));
        assert!(s.contains("started_at: 2026-04-26T10:00:00+00:00\n"));
        assert!(s.contains("message_count: 4\n"));
        assert!(s.contains("source_mtime_nanos: 1234567890\n"));
        assert!(s.contains("topic: patent v7 review\n"));
        assert!(s.contains("# patent v7 review\n"));
        assert!(s.contains("User: hi"));
    }

    #[test]
    fn render_atom_quotes_topic_with_colon() {
        let atom = PersonalAgentAtom {
            source: "claude-code".to_string(),
            conversation_id: "u".to_string(),
            started_at: None,
            ended_at: None,
            message_count: 0,
            topic: "fix: bug".to_string(),
            source_mtime_nanos: 0,
            body: String::new(),
        };
        let s = render_atom(&atom);
        assert!(s.contains("topic: \"fix: bug\""));
        // Empty body falls back to a placeholder so the file is never
        // stranded as just frontmatter.
        assert!(s.contains("_(empty conversation)_"));
    }

    #[test]
    fn read_atom_source_mtime_round_trips() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_mtime_{}.md",
            uuid::Uuid::new_v4().simple()
        ));
        let atom = PersonalAgentAtom {
            source: "cursor".to_string(),
            conversation_id: "x".to_string(),
            started_at: None,
            ended_at: None,
            message_count: 1,
            topic: "t".to_string(),
            source_mtime_nanos: 9_876_543_210,
            body: "**User**: hi\n".to_string(),
        };
        std::fs::write(&tmp, render_atom(&atom)).unwrap();
        let got = read_atom_source_mtime(&tmp).expect("should round-trip");
        assert_eq!(got, 9_876_543_210);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_atom_source_mtime_returns_none_for_missing_file() {
        let p = std::path::PathBuf::from("/definitely/not/here.md");
        assert!(read_atom_source_mtime(&p).is_none());
    }

    #[test]
    fn topic_from_first_message_caps_length() {
        let s = topic_from_first_message(&"a".repeat(200));
        assert!(s.chars().count() <= 80);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn topic_from_first_message_strips_newlines() {
        let s = topic_from_first_message("hello\nworld");
        assert_eq!(s, "hello world");
    }

    #[test]
    fn agent_id_strings_match_dir_names() {
        assert_eq!(agent_id(PersonalAgentSource::Cursor), "cursor");
        assert_eq!(agent_id(PersonalAgentSource::ClaudeCode), "claude-code");
        assert_eq!(agent_id(PersonalAgentSource::Codex), "codex");
        assert_eq!(agent_id(PersonalAgentSource::Windsurf), "windsurf");
    }

    // === v1.14.5 round-6 ===
    /// R6 audit — `probe_local_dir` MUST distinguish "missing dir"
    /// (NotInstalled — silent grey dot) from "exists but unreadable"
    /// (AccessDenied — loud amber warning). Pre-R6 every error class
    /// folded into `false` so the user couldn't tell them apart. This
    /// test asserts the structured contract that the SCAN UI relies on.
    #[test]
    fn probe_local_dir_distinguishes_missing_from_unreadable() {
        // Missing: a path that definitely doesn't exist.
        let missing = std::env::temp_dir()
            .join(format!("tii_r6_missing_{}", uuid::Uuid::new_v4().simple()));
        let s = probe_local_dir(&missing);
        assert!(
            matches!(s, PersonalAgentDetectionStatus::NotInstalled),
            "missing path must surface as NotInstalled, got {:?}",
            s,
        );

        // "Exists but isn't a dir" — `read_dir` returns an error, which
        // R6 surfaces as AccessDenied so the user sees something is off
        // instead of a silent NotInstalled. We use a temp file (not a
        // dir) to trigger this on every OS without needing a real perm
        // denial (which is hard to set up portably in unit tests).
        let file_path = std::env::temp_dir()
            .join(format!("tii_r6_file_{}.txt", uuid::Uuid::new_v4().simple()));
        std::fs::write(&file_path, b"not a dir").unwrap();
        let s = probe_local_dir(&file_path);
        // On Windows + macOS this surfaces as `Other` / `NotADirectory`;
        // on Linux 6.x it's `NotADirectory`. R6 folds every non-NotFound /
        // non-PermissionDenied error into AccessDenied.
        assert!(
            matches!(s, PersonalAgentDetectionStatus::AccessDenied { .. }),
            "non-dir path must surface as AccessDenied, got {:?}",
            s,
        );
        let _ = std::fs::remove_file(&file_path);
    }

    /// `probe_candidates` MUST prefer AccessDenied over NotInstalled —
    /// the trust-collapse case. A user with one missing candidate dir +
    /// one perm-denied candidate dir cares about the perm denial, not
    /// the silent grey dot. Pre-R6 the bool would have collapsed both
    /// to "false" and the user would think Cursor wasn't installed.
    #[test]
    fn probe_candidates_prefers_access_denied_over_missing() {
        let missing = std::env::temp_dir()
            .join(format!("tii_r6_missing2_{}", uuid::Uuid::new_v4().simple()));
        let file_path = std::env::temp_dir()
            .join(format!("tii_r6_file2_{}.txt", uuid::Uuid::new_v4().simple()));
        std::fs::write(&file_path, b"not a dir").unwrap();

        // Order: missing first, file second. The file probe returns
        // AccessDenied; that MUST win over the NotInstalled from the
        // missing dir.
        let s = probe_candidates(&[missing.clone(), file_path.clone()]);
        assert!(
            matches!(s, PersonalAgentDetectionStatus::AccessDenied { .. }),
            "AccessDenied must win over NotInstalled, got {:?}",
            s,
        );

        // Reverse order: file first, missing second. Same answer — the
        // helper must be order-independent.
        let s = probe_candidates(&[file_path.clone(), missing.clone()]);
        assert!(
            matches!(s, PersonalAgentDetectionStatus::AccessDenied { .. }),
            "AccessDenied must win regardless of order, got {:?}",
            s,
        );

        // All-missing: falls back to NotInstalled.
        let missing2 = std::env::temp_dir()
            .join(format!("tii_r6_missing3_{}", uuid::Uuid::new_v4().simple()));
        let s = probe_candidates(&[missing.clone(), missing2.clone()]);
        assert!(
            matches!(s, PersonalAgentDetectionStatus::NotInstalled),
            "all-missing must collapse to NotInstalled, got {:?}",
            s,
        );

        // An installed dir short-circuits — Installed always wins.
        let installed_dir = std::env::temp_dir()
            .join(format!("tii_r6_dir_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&installed_dir).unwrap();
        let s = probe_candidates(&[file_path.clone(), installed_dir.clone()]);
        assert!(
            matches!(s, PersonalAgentDetectionStatus::Installed),
            "Installed must short-circuit even with AccessDenied present, got {:?}",
            s,
        );

        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir_all(&installed_dir);
    }

    /// Remote-source helper — RemoteUnconfigured when the dest dir is
    /// missing or empty, Installed once a single .md atom lands. The
    /// `detected: bool` mirror in PersonalAgentSummary uses this to
    /// flip the green dot on for Devin / Replit / MS Copilot.
    #[test]
    fn probe_remote_dest_states() {
        let tmp = std::env::temp_dir()
            .join(format!("tii_r6_remote_{}", uuid::Uuid::new_v4().simple()));

        // Missing dir → RemoteUnconfigured.
        let s = probe_remote_dest(&tmp);
        assert!(matches!(s, PersonalAgentDetectionStatus::RemoteUnconfigured));

        // Empty dir → still RemoteUnconfigured.
        std::fs::create_dir_all(&tmp).unwrap();
        let s = probe_remote_dest(&tmp);
        assert!(matches!(s, PersonalAgentDetectionStatus::RemoteUnconfigured));

        // Dir with a non-.md file → still RemoteUnconfigured (we only
        // count .md atoms — a stray .DS_Store / .gitignore doesn't flip
        // the row to Installed).
        std::fs::write(tmp.join(".DS_Store"), b"").unwrap();
        let s = probe_remote_dest(&tmp);
        assert!(matches!(s, PersonalAgentDetectionStatus::RemoteUnconfigured));

        // Dir with a .md atom → Installed.
        std::fs::write(tmp.join("session-1.md"), b"---\nsource: devin\n---\n").unwrap();
        let s = probe_remote_dest(&tmp);
        assert!(matches!(s, PersonalAgentDetectionStatus::Installed));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// PersonalAgentDetectionStatus serialization stays in sync with the
    /// TS narrowing: `{"kind": "access_denied", "reason": "..."}`.
    /// Without this, the SCAN UI would silently fall back to the
    /// "not_installed" branch on every Tauri response.
    #[test]
    fn detection_status_serializes_as_tagged_union() {
        let s = PersonalAgentDetectionStatus::AccessDenied {
            reason: "permission denied: Access is denied. (os error 5)".to_string(),
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j.get("kind").and_then(|v| v.as_str()), Some("access_denied"));
        assert!(j.get("reason").and_then(|v| v.as_str()).unwrap().contains("permission"));

        let s = PersonalAgentDetectionStatus::PlatformUnsupported {
            reason: "Apple Intelligence requires macOS".to_string(),
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j.get("kind").and_then(|v| v.as_str()), Some("platform_unsupported"));

        let s = PersonalAgentDetectionStatus::Installed;
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j.get("kind").and_then(|v| v.as_str()), Some("installed"));

        let s = PersonalAgentDetectionStatus::RemoteUnconfigured;
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j.get("kind").and_then(|v| v.as_str()), Some("remote_unconfigured"));
    }
    // === end v1.14.5 round-6 ===
}
