// === wave 1.13-E ===
//! v1.13 Agent E — Microsoft Teams source connector.
//!
//! Reads channel + chat messages from teams the user belongs to via Microsoft
//! Graph (`https://graph.microsoft.com/v1.0/me/chats`,
//! `/teams/{id}/channels/{id}/messages`). Writes one atom per message under
//! `<memory_root>/personal/<user>/threads/teams/<message_id>.md`.
//!
//! Auth model
//! ==========
//! Microsoft identity platform OAuth (Azure AD app registration). The app
//! must declare `Chat.Read` + `OnlineMeetings.Read.All` (delegated) scopes.
//! The chat-driven setup (see `commands::onboarding_chat::execute_setup_source_teams`)
//! opens the consent URL in the system browser, listens on a localhost
//! callback for the auth code, and exchanges it for tokens stored via
//! `secret_store::secret_store_set_oauth` keyed under
//! `tangerine.source.teams.<account>`.
//!
//! Polling cadence
//! ===============
//! Default 60s. Graph supports change notifications (webhook subscriptions)
//! but those need a public HTTPS callback the app can't easily host on a
//! laptop — README documents the upgrade path for self-hosted deployments.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TeamsConfig {
    #[serde(default)]
    pub account_alias: String,
    /// Tenant id when the app is registered in a single-tenant Azure AD; for
    /// multi-tenant apps (the dogfood default) this is `common`.
    #[serde(default = "default_tenant")]
    pub tenant: String,
    /// Microsoft Graph base. Locked unless someone tests against a sovereign
    /// cloud (US Gov / China 21Vianet).
    #[serde(default = "default_graph_base")]
    pub graph_base: String,
    #[serde(default = "default_poll_seconds")]
    pub poll_interval_seconds: u32,
    #[serde(default)]
    pub enabled: bool,
}

fn default_tenant() -> String {
    "common".to_string()
}

fn default_graph_base() -> String {
    "https://graph.microsoft.com/v1.0".to_string()
}

fn default_poll_seconds() -> u32 {
    60
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TeamsFetchResult {
    pub atoms_written: u32,
    pub items_seen: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TeamsAtomInput<'a> {
    pub message_id: &'a str,
    pub chat_or_channel_id: &'a str,
    pub sender: &'a str,
    pub message_text: &'a str,
    pub team_name: &'a str,
    pub channel_name: &'a str,
    pub ts: DateTime<Utc>,
}

pub fn format_teams_atom(input: &TeamsAtomInput<'_>) -> String {
    let safe_sender = if input.sender.is_empty() { "(unknown)" } else { input.sender };
    let team_line = if input.team_name.is_empty() {
        String::new()
    } else {
        format!("team: {}\n", yaml_scalar(input.team_name))
    };
    let channel_line = if input.channel_name.is_empty() {
        String::new()
    } else {
        format!("channel: {}\n", yaml_scalar(input.channel_name))
    };
    format!(
        "---\n\
source: teams\n\
message_id: {message_id}\n\
context_id: {context_id}\n\
sender: {sender}\n\
ts: {ts}\n\
{team_line}\
{channel_line}\
captured_by: tangerine-teams-source\n\
---\n\
\n\
{body}\n",
        message_id = yaml_scalar(input.message_id),
        context_id = yaml_scalar(input.chat_or_channel_id),
        sender = yaml_scalar(safe_sender),
        ts = input.ts.to_rfc3339(),
        team_line = team_line,
        channel_line = channel_line,
        body = input.message_text.trim(),
    )
}

pub fn message_filename(input: &TeamsAtomInput<'_>) -> String {
    let cleaned: String = input
        .message_id
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

pub fn resolve_teams_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads")
        .join("teams")
}

pub async fn ingest_tick_stub(cfg: &TeamsConfig) -> TeamsFetchResult {
    if !cfg.enabled {
        return TeamsFetchResult {
            errors: vec!["teams source disabled".to_string()],
            ..Default::default()
        };
    }
    // Real flow:
    //   1. Resolve OAuth access token via secret_store; refresh against
    //      https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
    //   2. GET /me/joinedTeams to enumerate teams.
    //   3. For each team: GET /teams/{id}/channels and /teams/{id}/channels/{id}/messages
    //   4. Plus 1:1 chats: GET /me/chats and /me/chats/{id}/messages
    //   5. Format with format_teams_atom and write to resolve_teams_dir.
    TeamsFetchResult::default()
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
        DateTime::parse_from_rfc3339("2026-04-27T11:30:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn atom_includes_team_and_channel_when_present() {
        let atom = format_teams_atom(&TeamsAtomInput {
            message_id: "msg-1",
            chat_or_channel_id: "ctx-1",
            sender: "Daizhe",
            message_text: "hello",
            team_name: "Tangerine",
            channel_name: "Engineering",
            ts: ts(),
        });
        assert!(atom.contains("source: teams"));
        assert!(atom.contains("team: Tangerine"));
        assert!(atom.contains("channel: Engineering"));
    }

    #[test]
    fn atom_skips_team_and_channel_lines_when_chat() {
        let atom = format_teams_atom(&TeamsAtomInput {
            message_id: "m",
            chat_or_channel_id: "c",
            sender: "x",
            message_text: "x",
            team_name: "",
            channel_name: "",
            ts: ts(),
        });
        assert!(!atom.contains("team:"));
        assert!(!atom.contains("channel:"));
    }

    #[test]
    fn dir_routes_under_personal_threads_teams() {
        let p = resolve_teams_dir(Path::new("/tmp/m"), "alice");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/teams"), "got {s}");
    }

    #[test]
    fn ingest_disabled_reports_error_not_panic() {
        let cfg = TeamsConfig::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let r = rt.block_on(ingest_tick_stub(&cfg));
        assert!(!r.errors.is_empty());
    }
}
// === end wave 1.13-E ===
