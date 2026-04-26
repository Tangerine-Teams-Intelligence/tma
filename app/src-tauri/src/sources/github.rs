//! GitHub writeback — posts a markdown comment on the linked PR / issue.
//!
//! The capture half (Phase 1) lives in `sources/github/` as a TS package
//! and writes atoms with `refs.github.url = https://github.com/<org>/<repo>/pull/<n>`.
//! The decisions atom inherits that URL into `source_id` (or `external_id`
//! in the newer schema). This module reverses the flow: parses the URL,
//! resolves an OAuth token via `commands::sync::TokenStore`, and POSTs to
//! the GitHub Issues API's `/comments` endpoint (which works for both PRs
//! and issues — GitHub treats PRs as a subset of issues for comments).
//!
//! Auth re-use note: we never add a fresh OAuth flow. The user already
//! went through the device-flow grant in v1.6 onboarding, so a token sits
//! in the OS keychain under `commands::sync::KEYRING_SERVICE`. We resolve
//! the login from `~/.tmi/config.yaml` (`writeback.github.login`) — falling
//! back to scanning the keychain via the standard heuristic only when
//! config is absent.

use serde::Serialize;
use std::path::Path;

use super::{SourceProvenance, WritebackOutcome};
use crate::commands::sync::TokenStore;
use crate::commands::AppError;

/// Format the markdown body we POST to GitHub. Pulled out as a pure
/// function so tests don't need an HTTP mock.
///
/// Format (locked — tests assert on this shape):
/// ```text
/// 🍊 **Tangerine — decision recorded**
///
/// {summary}
///
/// _Source: ~/.tangerine-memory/decisions/{filename}_
/// ```
pub fn format_github_comment_body(prov: &SourceProvenance) -> String {
    let summary_block = if prov.summary.trim().is_empty() {
        // Fall back to a short title-only line if the body had no
        // ## Decision section to extract from.
        if prov.title.is_empty() {
            "(no summary recorded)".to_string()
        } else {
            prov.title.clone()
        }
    } else {
        prov.summary.clone()
    };
    format!(
        "🍊 **Tangerine — decision recorded**\n\n{summary}\n\n_Source: ~/.tangerine-memory/decisions/{file}_",
        summary = summary_block,
        file = prov.filename,
    )
}

/// Parsed `org/repo/<kind>/<n>` triple. The GitHub Issues comment endpoint
/// works for both PRs and issues since PRs are issues with extra columns —
/// we POST to `/repos/{org}/{repo}/issues/{n}/comments` regardless.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubTarget {
    pub org: String,
    pub repo: String,
    pub number: u64,
    /// `pull` or `issues` — preserved for the response URL we hand back to
    /// the UI (a PR-thread comment URL has `/pull/<n>` not `/issues/<n>`,
    /// even though the POST endpoint is identical).
    pub kind: String,
}

/// Parse a GitHub PR or issue URL out of an arbitrary `external_id`
/// (typically the value the capture-side wrote into `refs.github.url`).
/// Returns `None` if the string isn't a recognisable GitHub URL.
pub fn parse_github_url(s: &str) -> Option<GithubTarget> {
    // Accept both https and http, with or without a trailing slash. We
    // do a cheap manual parse rather than pull in `url` — the format is
    // tightly constrained.
    let s = s.trim();
    let stripped = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))?;
    let stripped = stripped.trim_end_matches('/');
    let parts: Vec<&str> = stripped.split('/').collect();
    if parts.len() < 4 {
        return None;
    }
    let kind = match parts[2] {
        "pull" | "pulls" => "pull",
        "issues" | "issue" => "issues",
        _ => return None,
    };
    let number: u64 = parts[3].parse().ok()?;
    Some(GithubTarget {
        org: parts[0].to_string(),
        repo: parts[1].to_string(),
        number,
        kind: kind.to_string(),
    })
}

/// Body the GitHub Issues comment API expects.
#[derive(Debug, Serialize)]
struct CommentRequest<'a> {
    body: &'a str,
}

/// Read the GitHub login from `~/.tmi/config.yaml` (`writeback.github.login`).
/// Returns `None` when the field isn't set; the caller treats that as a
/// "configure your GitHub login first" UX error.
pub fn resolve_github_login(config_path: &Path) -> Option<String> {
    let yaml = std::fs::read_to_string(config_path).ok()?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).ok()?;
    parsed
        .get("writeback")
        .and_then(|w| w.get("github"))
        .and_then(|g| g.get("login"))
        .and_then(|l| l.as_str())
        .map(|s| s.to_string())
}

/// Returns true when `writeback.github.enabled` is set to `true` in
/// `~/.tmi/config.yaml`. Default is `false` — the user has to opt in via
/// the Sources/GitHub page toggle.
pub fn writeback_enabled(config_path: &Path) -> bool {
    let yaml = match std::fs::read_to_string(config_path) {
        Ok(y) => y,
        Err(_) => return false,
    };
    let parsed: serde_yaml::Value = match serde_yaml::from_str(&yaml) {
        Ok(p) => p,
        Err(_) => return false,
    };
    parsed
        .get("writeback")
        .and_then(|w| w.get("github"))
        .and_then(|g| g.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Post the markdown comment back to GitHub. Reuses `commands::sync::TokenStore`
/// for auth — never asks the user a fresh OAuth question.
pub async fn writeback_decision(
    http: &reqwest::Client,
    config_path: &Path,
    prov: &SourceProvenance,
) -> Result<WritebackOutcome, AppError> {
    if !writeback_enabled(config_path) {
        return Ok(WritebackOutcome::Disabled);
    }
    let target = match parse_github_url(&prov.external_id) {
        Some(t) => t,
        None => {
            return Ok(WritebackOutcome::NotApplicable {
                reason: format!(
                    "decision frontmatter source_id='{}' is not a github URL",
                    prov.external_id
                ),
            });
        }
    };
    let login = match resolve_github_login(config_path) {
        Some(l) => l,
        None => {
            return Ok(WritebackOutcome::Failed {
                error: "writeback.github.login is not set in ~/.tmi/config.yaml".into(),
            });
        }
    };
    let token = match TokenStore::get(&login) {
        Ok(t) => t,
        Err(e) => {
            return Ok(WritebackOutcome::Failed {
                error: format!("no GitHub token for login '{}': {}", login, e),
            });
        }
    };

    let body = format_github_comment_body(prov);
    let endpoint = format!(
        "https://api.github.com/repos/{}/{}/issues/{}/comments",
        target.org, target.repo, target.number
    );
    let payload = CommentRequest { body: &body };
    let res = http
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "TangerineMeeting")
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::external("github_writeback", e.to_string()))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| AppError::external("github_writeback_body", e.to_string()))?;
    if !status.is_success() {
        return Ok(WritebackOutcome::Failed {
            error: format!("GitHub returned {}: {}", status.as_u16(), redact(&text, 200)),
        });
    }
    // Pull `html_url` out of the JSON response so the UI can deep-link.
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let html_url = parsed
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            format!(
                "https://github.com/{}/{}/{}/{}",
                target.org, target.repo, target.kind, target.number
            )
        });
    Ok(WritebackOutcome::Posted {
        external_url: html_url,
        kind: format!("github_{}_comment", target.kind),
    })
}

/// Trim a string to at most `max` chars. Used when surfacing API error
/// bodies in `WritebackOutcome::Failed` so we don't dump kilobytes of
/// HTML into the writeback log.
fn redact(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_prov() -> SourceProvenance {
        SourceProvenance {
            source: "github".into(),
            external_id: "https://github.com/Tangerine-Intelligence/legal-documents/pull/42".into(),
            title: "Use bcrypt for password hashing".into(),
            summary: "We'll use **bcrypt** with cost factor 12.".into(),
            body: "## Decision\n\nWe'll use **bcrypt** with cost factor 12.\n".into(),
            filename: "bcrypt-decision.md".into(),
        }
    }

    #[test]
    fn test_writeback_format_github_comment() {
        // The prompt's spec contract: body must contain 🍊, the summary,
        // and the source path.
        let prov = sample_prov();
        let body = format_github_comment_body(&prov);
        assert!(body.contains("🍊"));
        assert!(body.contains("Tangerine — decision recorded"));
        assert!(body.contains("bcrypt"));
        assert!(body.contains("~/.tangerine-memory/decisions/bcrypt-decision.md"));
    }

    #[test]
    fn format_falls_back_to_title_when_no_summary() {
        let mut prov = sample_prov();
        prov.summary = String::new();
        let body = format_github_comment_body(&prov);
        // Title makes it into the body when summary is empty.
        assert!(body.contains("Use bcrypt for password hashing"));
    }

    #[test]
    fn format_falls_back_to_placeholder_when_no_summary_or_title() {
        let mut prov = sample_prov();
        prov.summary = String::new();
        prov.title = String::new();
        let body = format_github_comment_body(&prov);
        assert!(body.contains("(no summary recorded)"));
    }

    #[test]
    fn parse_pr_url() {
        let t = parse_github_url("https://github.com/foo/bar/pull/123").unwrap();
        assert_eq!(t.org, "foo");
        assert_eq!(t.repo, "bar");
        assert_eq!(t.number, 123);
        assert_eq!(t.kind, "pull");
    }

    #[test]
    fn parse_issue_url() {
        let t = parse_github_url("https://github.com/foo/bar/issues/77/").unwrap();
        assert_eq!(t.kind, "issues");
        assert_eq!(t.number, 77);
    }

    #[test]
    fn parse_invalid_url_returns_none() {
        assert!(parse_github_url("https://gitlab.com/foo/bar/-/issues/1").is_none());
        assert!(parse_github_url("not a url").is_none());
        assert!(parse_github_url("https://github.com/foo").is_none());
        assert!(parse_github_url("https://github.com/foo/bar/wiki/page").is_none());
    }

    #[test]
    fn writeback_enabled_defaults_false() {
        let dir = tempdir();
        let cfg = dir.path().join("missing.yaml");
        assert!(!writeback_enabled(&cfg));
    }

    #[test]
    fn writeback_enabled_true_when_config_says_true() {
        let dir = tempdir();
        let cfg = dir.path().join("config.yaml");
        std::fs::write(
            &cfg,
            "writeback:\n  github:\n    enabled: true\n    login: daizhe\n",
        )
        .unwrap();
        assert!(writeback_enabled(&cfg));
        assert_eq!(resolve_github_login(&cfg), Some("daizhe".to_string()));
    }

    #[test]
    fn redact_truncates_long_strings() {
        let s = "x".repeat(500);
        let r = redact(&s, 100);
        assert!(r.chars().count() <= 101); // 100 + ellipsis
        assert!(r.ends_with('…'));
    }

    fn tempdir() -> tempfile_minimal::TempDir {
        tempfile_minimal::TempDir::new("ti-gh-writeback")
    }
}

// Tiny dependency-free tempdir helper. We don't already depend on
// `tempfile`, and the test surface here is small; keeping it self-contained
// avoids the dep churn.
#[cfg(test)]
mod tempfile_minimal {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(prefix: &str) -> Self {
            let base = std::env::temp_dir();
            let dir = base.join(format!("{}-{}", prefix, uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).expect("mkdir tempdir");
            Self(dir)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
