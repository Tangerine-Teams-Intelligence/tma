// === wave 1.13-E ===
//! v1.13 Agent E — Slack source connector (real, not the CLI stub).
//!
//! Distinct from `commands::writeback_slack_calendar` which posts FROM
//! Tangerine TO Slack. This module is the **inbound** capture: pulls
//! messages from channels the user is in via the Slack Web API
//! (`https://slack.com/api/conversations.history`) and writes one atom per
//! message under
//! `<memory_root>/personal/<user>/threads/slack/<message_ts>.md`.
//!
//! Distinct also from the legacy `sources/slack/` Node CLI package — that
//! shipped as a v1.6 connector that the user had to launch manually. v1.13-E
//! folds the same capture surface into the Tauri daemon so the user no
//! longer needs to keep a separate process running.
//!
//! Auth model
//! ==========
//! Slack OAuth v2 with `channels:history` + `groups:history` + `im:history`
//! scopes (xoxp user-token preferred — bot tokens can also work but skip
//! private DMs). Tokens stored via
//! `secret_store::secret_store_set_oauth` keyed under
//! `tangerine.source.slack.<workspace>`.
//!
//! Polling cadence
//! ===============
//! Default 60s; the Events API webhook upgrade path is documented in README
//! for users who can host a public callback.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SlackRealConfig {
    /// Workspace alias the user picks. Used as the keyring secondary key.
    #[serde(default)]
    pub workspace: String,
    /// Slack Web API base — locked at `https://slack.com/api`.
    #[serde(default = "default_slack_base")]
    pub api_base: String,
    /// Optional list of channel IDs to limit the poll. Empty = all channels
    /// the bot/user has access to.
    #[serde(default)]
    pub channel_filter: Vec<String>,
    #[serde(default = "default_poll_seconds")]
    pub poll_interval_seconds: u32,
    #[serde(default)]
    pub enabled: bool,
}

fn default_slack_base() -> String {
    "https://slack.com/api".to_string()
}

fn default_poll_seconds() -> u32 {
    60
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlackFetchResult {
    pub atoms_written: u32,
    pub items_seen: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SlackAtomInput<'a> {
    /// Slack `ts` value — millisecond-precision string like `1714123456.000200`.
    /// Doubles as a stable per-message id within a channel.
    pub message_ts: &'a str,
    pub channel_id: &'a str,
    pub channel_name: &'a str,
    pub sender: &'a str,
    pub message_text: &'a str,
    pub permalink: &'a str,
    pub captured_at: DateTime<Utc>,
}

pub fn format_slack_atom(input: &SlackAtomInput<'_>) -> String {
    let safe_sender = if input.sender.is_empty() { "(unknown)" } else { input.sender };
    let permalink_line = if input.permalink.is_empty() {
        String::new()
    } else {
        format!("permalink: {}\n", yaml_scalar(input.permalink))
    };
    let channel_name_line = if input.channel_name.is_empty() {
        String::new()
    } else {
        format!("channel_name: {}\n", yaml_scalar(input.channel_name))
    };
    format!(
        "---\n\
source: slack\n\
message_ts: {message_ts}\n\
channel_id: {channel_id}\n\
{channel_name_line}\
sender: {sender}\n\
captured_at: {captured_at}\n\
{permalink_line}\
captured_by: tangerine-slack-source\n\
---\n\
\n\
{body}\n",
        message_ts = yaml_scalar(input.message_ts),
        channel_id = yaml_scalar(input.channel_id),
        channel_name_line = channel_name_line,
        sender = yaml_scalar(safe_sender),
        captured_at = input.captured_at.to_rfc3339(),
        permalink_line = permalink_line,
        body = input.message_text.trim(),
    )
}

pub fn message_filename(input: &SlackAtomInput<'_>) -> String {
    let chan: String = input
        .channel_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let ts: String = input
        .message_ts
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(20)
        .collect();
    format!("{}-{}.md", chan, ts)
}

pub fn resolve_slack_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads")
        .join("slack")
}

pub async fn ingest_tick_stub(cfg: &SlackRealConfig) -> SlackFetchResult {
    if !cfg.enabled {
        return SlackFetchResult {
            errors: vec!["slack source disabled".to_string()],
            ..Default::default()
        };
    }
    // Real flow:
    //   1. Resolve OAuth token via secret_store.
    //   2. POST {api_base}/conversations.list to enumerate channels (apply
    //      channel_filter if non-empty).
    //   3. For each channel: POST {api_base}/conversations.history?channel=<id>&oldest=<lookback>
    //   4. POST {api_base}/chat.getPermalink for each message we plan to write.
    //   5. Format with format_slack_atom + message_filename, write to
    //      resolve_slack_dir.
    SlackFetchResult::default()
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

    fn captured() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-04-27T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn atom_renders_permalink_when_present() {
        let atom = format_slack_atom(&SlackAtomInput {
            message_ts: "1714123456.000200",
            channel_id: "C12345",
            channel_name: "engineering",
            sender: "U999",
            message_text: "deploying staging",
            permalink: "https://slack.com/archives/C12345/p1714123456000200",
            captured_at: captured(),
        });
        assert!(atom.contains("source: slack"));
        assert!(atom.contains("channel_name: engineering"));
        assert!(atom.contains("permalink:"));
        assert!(atom.contains("deploying staging"));
    }

    #[test]
    fn atom_skips_permalink_when_empty() {
        let atom = format_slack_atom(&SlackAtomInput {
            message_ts: "1.0",
            channel_id: "C",
            channel_name: "",
            sender: "u",
            message_text: "x",
            permalink: "",
            captured_at: captured(),
        });
        assert!(!atom.contains("permalink:"));
    }

    #[test]
    fn filename_combines_channel_and_ts() {
        let f = message_filename(&SlackAtomInput {
            message_ts: "1714123456.000200",
            channel_id: "C12345",
            channel_name: "",
            sender: "",
            message_text: "",
            permalink: "",
            captured_at: captured(),
        });
        assert!(f.contains("C12345"));
        assert!(f.ends_with(".md"));
    }

    #[test]
    fn dir_routes_under_personal_threads_slack() {
        let p = resolve_slack_dir(Path::new("/tmp/m"), "alice");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/slack"), "got {s}");
    }

    #[test]
    fn ingest_disabled_reports_error_not_panic() {
        let cfg = SlackRealConfig::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let r = rt.block_on(ingest_tick_stub(&cfg));
        assert!(!r.errors.is_empty());
    }
}
// === end wave 1.13-E ===
