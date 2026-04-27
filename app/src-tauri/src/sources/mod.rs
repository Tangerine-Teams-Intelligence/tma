//! v1.8 Phase 2 — source-connector writeback adapters.
//!
//! Phase 1 (`sources/<name>/` Node packages) ingests external systems into
//! atoms. Phase 2 closes the loop: when an atom-decision is finalised in
//! `~/.tangerine-memory/decisions/*.md`, Tangerine posts back to the
//! originating system — a markdown comment on the linked GitHub PR/issue,
//! or a new "decision recorded" issue in the linked Linear project.
//!
//! Layout:
//!   * `github.rs` — GitHub PR/issue comment writeback.
//!   * `linear.rs` — Linear new-issue writeback (Done state, label
//!     `tangerine-decision`).
//!   * `writeback_log` — persistent dedup record at
//!     `~/.tangerine-memory/.tangerine/writeback-log.json`.
//!   * `watcher` — `notify` watcher over `decisions/*.md`. Reads frontmatter,
//!     looks up the source provenance, calls the right writeback adapter.
//!
//! Design notes:
//!   * Auth reuse — never adds a new auth flow. GitHub uses the existing
//!     OAuth device-flow token from `commands::sync::TokenStore`; Linear
//!     uses `LINEAR_API_KEY` from the shared `.env` allowlist.
//!   * The writeback toggle lives in `~/.tmi/config.yaml` under
//!     `writeback.<source>.enabled`. The watcher reads it on every event so
//!     toggling at runtime takes effect immediately.
//!   * Dedup is by atom id (frontmatter `source_id` + filename hash). On a
//!     second write of the same decision the watcher sees a writeback-log
//!     entry and skips. This handles the common case where the user edits
//!     the decision file post-write and the watcher fires again.
//!   * Tests mock HTTP via reqwest's `mockito` *would* be ideal but the
//!     repo's `reqwest::Client` has no test injection seam. Instead we
//!     factor the request-body builders out as pure functions with their
//!     own unit tests (`format_github_comment_body`, `format_linear_issue`)
//!     and run the dedup logic against a tempdir-backed log.

pub mod github;
pub mod linear;
pub mod watcher;
pub mod writeback_log;

// v1.8 Phase 2-D — ingest-side connectors. These live in the same module
// namespace as the writeback adapters because they're conceptually the same
// kind of thing (a source connector), but the data flow is reversed: they
// pull external state and write atoms into `~/.tangerine-memory/threads/`.
pub mod email;
pub mod voice_notes;

// === v3.0 external world ===
// v3.0 Layer 6 — external world capture. RSS / podcast / YouTube /
// generic article readers. Each writes atoms under
// `<memory_root>/personal/<user>/threads/external/<source-type>/`. The
// daemon's daily cron tick polls subscribed feeds; the Tauri command
// surface in `crate::commands::external` exposes opt-in subscribe /
// fetch-now / paste-to-capture entry points.
pub mod external;
// === end v3.0 external world ===

use serde::{Deserialize, Serialize};

/// Result of a writeback attempt. Returned both to the auto-watcher (which
/// records it in the log) and to the manual `writeback_decision` Tauri
/// command (so the UI can render an inline status).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WritebackOutcome {
    /// Successful writeback — `external_url` is the URL the user can click
    /// to see the freshly-posted comment / issue.
    Posted { external_url: String, kind: String },
    /// We've already posted for this decision. The watcher reuses this so
    /// repeated saves of the same `decisions/foo.md` don't spam GitHub.
    AlreadyDone { external_url: String },
    /// The decision file's frontmatter doesn't link back to a GitHub
    /// PR/issue or a Linear issue, so there's nothing to post to. Treated
    /// as a soft success — the watcher logs it without complaint.
    NotApplicable { reason: String },
    /// Writeback is disabled for this source via the config toggle. The
    /// watcher still records the attempt so the UI can surface "would have
    /// posted N decisions if you'd had writeback on".
    Disabled,
    /// Hard failure — the HTTP call returned non-2xx, or the auth token
    /// wasn't available, or the frontmatter was malformed beyond recovery.
    /// `error` is human-readable; the watcher records it but does not
    /// retry (avoids tight loops on a structural problem).
    Failed { error: String },
}

impl WritebackOutcome {
    /// True if the operation should be considered a "completed" attempt
    /// from the dedup perspective. Posted + AlreadyDone + NotApplicable +
    /// Disabled all stop the watcher from retrying. Only `Failed` is
    /// retryable — and even then we cap retries via the log.
    pub fn is_terminal(&self) -> bool {
        !matches!(self, Self::Failed { .. })
    }
}

/// Source provenance extracted from a decision file's frontmatter.
/// `source` is the lowercase connector name (`github` / `linear`).
/// `external_id` is whatever string the connector wrote when capturing —
/// typically a URL for GitHub PRs and an issue identifier (`ENG-123`) for
/// Linear, but we accept either freely so the format can evolve without
/// breaking writeback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceProvenance {
    pub source: String,
    pub external_id: String,
    /// Decision title from `title:` frontmatter — used as the Linear issue
    /// title. May be empty; the writeback adapter falls back to the file
    /// stem.
    pub title: String,
    /// Decision summary — first H2 block or the body before the
    /// `## Provenance` section. We don't try to reformat; pass through
    /// verbatim with a length cap.
    pub summary: String,
    /// Full decision body (post-frontmatter), used as the Linear issue
    /// body and as the GitHub comment body when the summary is empty.
    pub body: String,
    /// Filename only (e.g. `sample-postgres-over-mongo.md`). Used in the
    /// GitHub comment footer link.
    pub filename: String,
}

/// Parse a decision file. Returns `None` when the file isn't a recognisable
/// decision (no frontmatter, or `source` field absent).
pub fn parse_decision_frontmatter(raw: &str, filename: &str) -> Option<SourceProvenance> {
    let (fm, body) = split_frontmatter(raw)?;
    let mut source: Option<String> = None;
    let mut external_id: Option<String> = None;
    let mut title: Option<String> = None;
    for line in fm.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("source:") {
            source = Some(unquote(rest.trim()));
        } else if let Some(rest) = trimmed.strip_prefix("source_id:") {
            external_id = Some(unquote(rest.trim()));
        } else if let Some(rest) = trimmed.strip_prefix("external_id:") {
            // Newer schema: explicit external_id wins over source_id when both
            // are present — `source_id` was the v1 field name and may carry
            // a meeting alias for non-external sources.
            external_id = Some(unquote(rest.trim()));
        } else if let Some(rest) = trimmed.strip_prefix("title:") {
            title = Some(unquote(rest.trim()));
        }
    }
    let source = source?;
    // Only `github` / `linear` connectors are wired. Other sources (meeting,
    // discord) return None so the watcher records NotApplicable.
    if !matches!(source.as_str(), "github" | "linear") {
        return None;
    }
    let external_id = external_id.unwrap_or_default();
    let title = title.unwrap_or_default();
    let summary = take_summary(&body);
    Some(SourceProvenance {
        source,
        external_id,
        title,
        summary,
        body,
        filename: filename.to_string(),
    })
}

/// Split a markdown file into (frontmatter, body). Returns None if the
/// file doesn't open with `---\n`.
fn split_frontmatter(raw: &str) -> Option<(String, String)> {
    let head = raw.trim_start_matches('\u{feff}');
    if !head.starts_with("---") {
        return None;
    }
    let after_open = head.strip_prefix("---")?.strip_prefix('\n')?;
    // Find the closing `\n---\n` (or `\n---\r\n`, or trailing `\n---`).
    let close_rel = after_open
        .find("\n---\n")
        .or_else(|| after_open.find("\n---\r\n"))
        .or_else(|| {
            if after_open.ends_with("\n---") {
                Some(after_open.len() - 4)
            } else {
                None
            }
        })?;
    let yaml_block = after_open[..close_rel].to_string();
    let after_close = &after_open[close_rel..];
    let body = if let Some(stripped) = after_close.strip_prefix("\n---\n") {
        stripped
    } else if let Some(stripped) = after_close.strip_prefix("\n---\r\n") {
        stripped
    } else {
        ""
    };
    Some((yaml_block, body.to_string()))
}

/// Strip surrounding quotes from a YAML scalar value.
fn unquote(s: &str) -> String {
    s.trim()
        .trim_matches(|c: char| c == '"' || c == '\'')
        .trim()
        .to_string()
}

/// Extract a summary line for the GitHub comment. Strategy:
///   1. The first paragraph after `## Decision` if present.
///   2. Otherwise the first non-empty paragraph in the body.
///   3. Capped at 600 chars so we don't paste a wall of text into a PR
///      thread (GitHub's UI gets ugly past ~500 chars on mobile).
fn take_summary(body: &str) -> String {
    const MAX: usize = 600;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    // Look for a `## Decision` (or `## Outcome`) heading.
    let start = lines
        .iter()
        .position(|l| {
            let l = l.trim_start();
            l.starts_with("## Decision") || l.starts_with("## Outcome")
        })
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut paragraph: Vec<String> = Vec::new();
    let mut seen_text = false;
    for line in &lines[start..] {
        let t = line.trim();
        if t.starts_with("##") {
            // Hit the next heading — stop.
            break;
        }
        if t.is_empty() {
            if seen_text {
                break;
            }
            continue;
        }
        seen_text = true;
        paragraph.push(t.to_string());
    }
    let joined = paragraph.join(" ");
    if joined.chars().count() <= MAX {
        joined
    } else {
        let mut buf = String::new();
        let mut count = 0usize;
        for c in joined.chars() {
            if count >= MAX - 1 {
                break;
            }
            buf.push(c);
            count += 1;
        }
        buf.push('…');
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_github_decision() -> &'static str {
        "---\n\
date: 2026-04-26\n\
title: Use bcrypt for password hashing\n\
source: github\n\
source_id: https://github.com/Tangerine-Intelligence/legal-documents/pull/42\n\
status: decided\n\
---\n\
\n\
## Decision\n\
\n\
We'll use **bcrypt** with cost factor 12.\n\
\n\
## Context\n\
\n\
Argon2id is overkill for our threat model.\n"
    }

    fn fixture_linear_decision() -> &'static str {
        "---\n\
date: 2026-04-26\n\
title: Ship Q2 OKRs by Friday\n\
source: linear\n\
external_id: ENG-456\n\
status: decided\n\
---\n\
\n\
## Decision\n\
\n\
Ship the OKRs.\n"
    }

    fn fixture_meeting_decision() -> &'static str {
        "---\n\
title: Meeting decision\n\
source: meeting\n\
source_id: sample-meeting\n\
---\n\
\n\
## Decision\n\
\n\
Some text.\n"
    }

    #[test]
    fn parses_github_decision() {
        let p = parse_decision_frontmatter(fixture_github_decision(), "bcrypt.md").unwrap();
        assert_eq!(p.source, "github");
        assert!(p.external_id.contains("github.com"));
        assert_eq!(p.title, "Use bcrypt for password hashing");
        assert!(p.summary.contains("bcrypt"));
        assert_eq!(p.filename, "bcrypt.md");
    }

    #[test]
    fn parses_linear_decision_with_external_id() {
        let p = parse_decision_frontmatter(fixture_linear_decision(), "okrs.md").unwrap();
        assert_eq!(p.source, "linear");
        assert_eq!(p.external_id, "ENG-456");
        assert_eq!(p.title, "Ship Q2 OKRs by Friday");
    }

    #[test]
    fn meeting_source_returns_none() {
        // We only wire writeback for `github` / `linear`; meeting decisions
        // are intentionally skipped.
        assert!(parse_decision_frontmatter(fixture_meeting_decision(), "x.md").is_none());
    }

    #[test]
    fn no_frontmatter_returns_none() {
        assert!(parse_decision_frontmatter("# just a heading\n\nsome text", "x.md").is_none());
    }

    #[test]
    fn summary_caps_at_600_chars() {
        let long = "a".repeat(2000);
        let raw = format!(
            "---\nsource: github\nsource_id: x\ntitle: T\n---\n\n## Decision\n\n{}\n",
            long
        );
        let p = parse_decision_frontmatter(&raw, "long.md").unwrap();
        // 599 chars + ellipsis
        assert!(p.summary.chars().count() <= 600);
        assert!(p.summary.ends_with('…'));
    }

    #[test]
    fn summary_uses_first_paragraph_when_no_decision_heading() {
        let raw = "---\nsource: github\nsource_id: x\ntitle: T\n---\n\nFirst paragraph here.\n\nSecond paragraph.";
        let p = parse_decision_frontmatter(raw, "x.md").unwrap();
        assert_eq!(p.summary, "First paragraph here.");
    }

    #[test]
    fn outcome_is_terminal_handles_failed() {
        assert!(WritebackOutcome::Posted {
            external_url: "u".into(),
            kind: "comment".into()
        }
        .is_terminal());
        assert!(WritebackOutcome::AlreadyDone {
            external_url: "u".into()
        }
        .is_terminal());
        assert!(WritebackOutcome::NotApplicable {
            reason: "x".into()
        }
        .is_terminal());
        assert!(WritebackOutcome::Disabled.is_terminal());
        assert!(!WritebackOutcome::Failed {
            error: "boom".into()
        }
        .is_terminal());
    }

    #[test]
    fn unquote_strips_double_and_single_quotes() {
        assert_eq!(unquote("\"foo\""), "foo");
        assert_eq!(unquote("'bar'"), "bar");
        assert_eq!(unquote("baz"), "baz");
    }
}
