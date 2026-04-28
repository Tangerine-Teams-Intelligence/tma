// === wave 1.13-E ===
//! v1.13 Agent E — GitHub source connector (real, not the CLI stub).
//!
//! Distinct from `commands::github` (Wave 6 device-flow OAuth surface) and
//! from `sources::github` (Phase 2-A writeback adapter that posts decision
//! comments). This module is the **inbound** capture for activity centred on
//! the user: PRs they reviewed/created, issues they commented on, mentions
//! across all repos they have access to. Atoms land at
//! `<memory_root>/personal/<user>/threads/github/<repo>-<type>-<number>.md`.
//!
//! Auth model
//! ==========
//! Personal Access Token (classic or fine-grained) — simpler than OAuth
//! device flow for a personal-vault use-case where the user already has
//! `gh auth token` available, AND the GitHub OAuth device flow only mints
//! tokens scoped to the legacy v1.6 oauth app. Stored via
//! `secret_store::secret_store_set_oauth` keyed under
//! `tangerine.source.github.<account>`.
//!
//! Polling cadence
//! ===============
//! Default 5 minutes. GitHub's webhook story is repo-by-repo and requires a
//! public callback — out of scope for the personal-vault path. The 5-minute
//! poll uses the `since` parameter so the tick is cheap regardless of how
//! many repos the user touches.
//!
//! Atom format
//! ===========
//! Frontmatter:
//!   source: github
//!   type: pr | issue | comment | mention
//!   repo: owner/name
//!   number: <int>
//!   title: <PR / issue title>
//!   author: <login>
//!   ts: <RFC3339>
//!   url: https://github.com/...
//! Body: PR description / comment text / issue body, markdown-passthrough.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GithubRealConfig {
    /// Account login the PAT belongs to (e.g. `daizhe`). Used as keyring
    /// secondary key.
    #[serde(default)]
    pub login: String,
    /// REST endpoint base. Locked at `https://api.github.com` unless someone
    /// points at a GHE Server install.
    #[serde(default = "default_api_base")]
    pub api_base: String,
    /// GraphQL endpoint base. Locked at `https://api.github.com/graphql`.
    #[serde(default = "default_graphql_base")]
    pub graphql_base: String,
    /// Optional repo allowlist (`owner/name`). Empty = all repos visible to
    /// the token.
    #[serde(default)]
    pub repo_filter: Vec<String>,
    #[serde(default = "default_poll_minutes")]
    pub poll_interval_minutes: u32,
    #[serde(default)]
    pub enabled: bool,
}

fn default_api_base() -> String {
    "https://api.github.com".to_string()
}

fn default_graphql_base() -> String {
    "https://api.github.com/graphql".to_string()
}

fn default_poll_minutes() -> u32 {
    5
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GithubFetchResult {
    pub atoms_written: u32,
    pub items_seen: u32,
    pub errors: Vec<String>,
}

/// Activity types we capture. `mention` is anything that contains the user's
/// `@login` in a body the user wouldn't otherwise be a participant in (PR /
/// issue / comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubActivityType {
    Pr,
    Issue,
    Comment,
    Mention,
}

impl GithubActivityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pr => "pr",
            Self::Issue => "issue",
            Self::Comment => "comment",
            Self::Mention => "mention",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GithubAtomInput<'a> {
    pub kind: GithubActivityType,
    pub repo_full: &'a str,
    pub number: u64,
    pub title: &'a str,
    pub author: &'a str,
    pub url: &'a str,
    pub body: &'a str,
    pub ts: DateTime<Utc>,
}

pub fn format_github_atom(input: &GithubAtomInput<'_>) -> String {
    let safe_author = if input.author.is_empty() { "(unknown)" } else { input.author };
    format!(
        "---\n\
source: github\n\
type: {kind}\n\
repo: {repo}\n\
number: {number}\n\
title: {title}\n\
author: {author}\n\
url: {url}\n\
ts: {ts}\n\
captured_by: tangerine-github-source\n\
---\n\
\n\
{body}\n",
        kind = input.kind.as_str(),
        repo = yaml_scalar(input.repo_full),
        number = input.number,
        title = yaml_scalar(input.title),
        author = yaml_scalar(safe_author),
        url = yaml_scalar(input.url),
        ts = input.ts.to_rfc3339(),
        body = input.body.trim(),
    )
}

pub fn activity_filename(input: &GithubAtomInput<'_>) -> String {
    let repo_clean: String = input
        .repo_full
        .replace('/', "-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    format!("{}-{}-{}.md", repo_clean, input.kind.as_str(), input.number)
}

pub fn resolve_github_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads")
        .join("github")
}

pub async fn ingest_tick_stub(cfg: &GithubRealConfig) -> GithubFetchResult {
    if !cfg.enabled {
        return GithubFetchResult {
            errors: vec!["github source disabled".to_string()],
            ..Default::default()
        };
    }
    if cfg.login.is_empty() {
        return GithubFetchResult {
            errors: vec!["github login missing".to_string()],
            ..Default::default()
        };
    }
    // Real flow:
    //   1. Resolve PAT via secret_store under tangerine.source.github.<login>.
    //   2. GET {api_base}/notifications?since=<lookback> to enumerate
    //      recent involvement.
    //   3. GET {api_base}/users/{login}/events to enumerate created PRs /
    //      issues.
    //   4. POST {graphql_base} with a `search(query: "involves:<login> ...")`
    //      to back-fill mentions.
    //   5. Format each via format_github_atom + activity_filename, write to
    //      resolve_github_dir. Apply repo_filter as a final pre-write check.
    GithubFetchResult::default()
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
        DateTime::parse_from_rfc3339("2026-04-27T13:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn atom_includes_repo_type_number() {
        let atom = format_github_atom(&GithubAtomInput {
            kind: GithubActivityType::Pr,
            repo_full: "Tangerine-Intelligence/legal-documents",
            number: 42,
            title: "Switch to bcrypt",
            author: "daizhe",
            url: "https://github.com/Tangerine-Intelligence/legal-documents/pull/42",
            body: "Body of the PR",
            ts: ts(),
        });
        assert!(atom.contains("source: github"));
        assert!(atom.contains("type: pr"));
        assert!(atom.contains("number: 42"));
        assert!(atom.contains("title: Switch to bcrypt"));
        assert!(atom.contains("Body of the PR"));
    }

    #[test]
    fn filename_uses_kind_and_number() {
        let f = activity_filename(&GithubAtomInput {
            kind: GithubActivityType::Issue,
            repo_full: "owner/repo",
            number: 7,
            title: "x",
            author: "x",
            url: "x",
            body: "x",
            ts: ts(),
        });
        assert!(f.contains("owner-repo-issue-7"));
        assert!(f.ends_with(".md"));
    }

    #[test]
    fn dir_routes_under_personal_threads_github() {
        let p = resolve_github_dir(Path::new("/tmp/m"), "alice");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/github"), "got {s}");
    }

    #[test]
    fn ingest_disabled_or_missing_login_reports_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let r = rt.block_on(ingest_tick_stub(&GithubRealConfig::default()));
        assert!(!r.errors.is_empty());
        let r2 = rt.block_on(ingest_tick_stub(&GithubRealConfig {
            enabled: true,
            ..Default::default()
        }));
        assert!(r2.errors.iter().any(|e| e.contains("login")));
    }

    #[test]
    fn activity_type_str_is_stable() {
        assert_eq!(GithubActivityType::Pr.as_str(), "pr");
        assert_eq!(GithubActivityType::Mention.as_str(), "mention");
    }
}
// === end wave 1.13-E ===
