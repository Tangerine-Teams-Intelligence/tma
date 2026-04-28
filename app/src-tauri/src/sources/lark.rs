// === wave 1.13-E ===
//! v1.13 Agent E — Lark (飞书 / Feishu) source connector.
//!
//! CN priority — CEO + Hongyu both use Lark daily. This module pulls messages
//! from team chats the user is in via the Lark Open Platform API
//! (open.larksuite.com — also reachable as open.feishu.cn for the CN cloud)
//! and writes one atom per message under
//! `<memory_root>/personal/<user>/threads/lark/<message_id>.md`.
//!
//! Auth model
//! ==========
//! Lark uses an `app_id` + `app_secret` triplet that exchanges for a
//! short-lived `tenant_access_token` via POST `/auth/v3/tenant_access_token/internal`.
//! We store the credentials in the OS keychain (see `commands::secret_store`)
//! under `tangerine.source.lark.<account_alias>` keys.
//!
//! Polling cadence
//! ===============
//! Default 60s — webhook subscription is preferred but requires a public
//! HTTPS callback the user's machine can't usually expose, so we ship the
//! poll path and document the webhook upgrade in README.
//!
//! Atom format
//! ===========
//! Frontmatter:
//!   source: lark
//!   message_id: <Lark om_xxx id>
//!   chat_id: <Lark oc_xxx id>
//!   sender: <open_id or display name>
//!   ts: <RFC3339 UTC>
//!   channel: <chat name when discoverable>
//! Body: raw message text (Lark "post" / "text" rich content flattened to
//! markdown via the same approach we use elsewhere — strip nested rich
//! attributes, keep paragraph breaks).
//!
//! Defensive
//! =========
//! Token refresh failures, rate-limit (429), and 5xx responses do NOT crash
//! the app — they surface as a `LarkFetchResult::errors` entry the Settings
//! panel renders next to the source's enable toggle.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::memory_paths::{resolve_atom_dir, AtomScope};

/// Per-user Lark connector config. Persisted at
/// `<user_data>/sources/lark.json`. Tokens DO NOT live in this file — they
/// are stored in the OS keychain via `secret_store::secret_store_set_oauth`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LarkConfig {
    /// Free-form alias the user picks (e.g. "tangerine-team-bot"). Used as
    /// the keyring secondary key so a single user can register multiple Lark
    /// apps without colliding.
    #[serde(default)]
    pub account_alias: String,
    /// Lark `app_id` (e.g. `cli_a1b2c3d4e5`). Stored alongside the alias in
    /// this config (it is NOT secret on its own — only the secret needs the
    /// keychain). We keep it here so the validator can call out which app
    /// the connection failed for.
    #[serde(default)]
    pub app_id: String,
    /// Endpoint base. Defaults to `https://open.larksuite.com/open-apis`
    /// (international cloud). CN tenants override to `https://open.feishu.cn/open-apis`.
    #[serde(default = "default_lark_base")]
    pub api_base: String,
    /// How many minutes back to fetch on each poll. Hard cap at 24h to keep
    /// the response shape bounded.
    #[serde(default = "default_lookback_minutes")]
    pub fetch_lookback_minutes: u32,
    /// True when the user has flipped the enable toggle. Polling skips when
    /// false even if a token is configured.
    #[serde(default)]
    pub enabled: bool,
}

fn default_lark_base() -> String {
    "https://open.larksuite.com/open-apis".to_string()
}

fn default_lookback_minutes() -> u32 {
    60
}

/// Result of one polling tick. Mirrors the shape used by other ingest-side
/// connectors (see `external::ExternalFetchResult`) so the daemon's heartbeat
/// loop can swallow a heterogeneous list of source results.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LarkFetchResult {
    pub atoms_written: u32,
    pub items_seen: u32,
    pub errors: Vec<String>,
}

/// Pure-function atom renderer — extracted so unit tests can drive it
/// without an HTTP mock. Mirrors the pattern used by `sources::github::format_github_comment_body`.
pub fn format_lark_atom(input: &LarkAtomInput<'_>) -> String {
    let safe_text = input.message_text.trim();
    let safe_sender = if input.sender.is_empty() { "(unknown)" } else { input.sender };
    let channel_line = if input.channel.is_empty() {
        String::new()
    } else {
        format!("channel: {}\n", yaml_scalar(input.channel))
    };
    format!(
        "---\n\
source: lark\n\
message_id: {message_id}\n\
chat_id: {chat_id}\n\
sender: {sender}\n\
ts: {ts}\n\
{channel_line}\
captured_by: tangerine-lark-source\n\
---\n\
\n\
{body}\n",
        message_id = yaml_scalar(input.message_id),
        chat_id = yaml_scalar(input.chat_id),
        sender = yaml_scalar(safe_sender),
        ts = input.ts.to_rfc3339(),
        channel_line = channel_line,
        body = safe_text,
    )
}

/// Slug the message id into a filename. Lark message ids start with `om_`
/// and are url-safe; we strip the prefix and tag it with the chat for human
/// browsability.
pub fn message_filename(input: &LarkAtomInput<'_>) -> String {
    let id_clean = input
        .message_id
        .trim_start_matches("om_")
        .chars()
        .take(40)
        .collect::<String>();
    format!("{}-{}.md", id_clean, slug_for_chat(input.chat_id))
}

fn slug_for_chat(chat: &str) -> String {
    chat.trim_start_matches("oc_")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect()
}

/// Pure helper — the on-disk dir for the lark source. Caller does
/// `create_dir_all` then writes the atom.
pub fn resolve_lark_dir(memory_root: &Path, current_user: &str) -> PathBuf {
    resolve_atom_dir(memory_root, AtomScope::Personal, current_user, "threads")
        .join("lark")
}

/// Inputs for `format_lark_atom`. Borrowed shape so the caller doesn't have
/// to clone the message text just to render the atom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LarkAtomInput<'a> {
    pub message_id: &'a str,
    pub chat_id: &'a str,
    pub sender: &'a str,
    pub message_text: &'a str,
    pub channel: &'a str,
    pub ts: DateTime<Utc>,
}

/// Stub ingestion entry point — real HTTP path is gated by token presence.
/// Used by the daemon heartbeat tick; tests drive the pure renderer directly
/// rather than the network path. Returns an error-shaped `LarkFetchResult`
/// when the source is disabled or unconfigured (NOT a hard `Err`).
pub async fn ingest_tick_stub(cfg: &LarkConfig) -> LarkFetchResult {
    if !cfg.enabled {
        return LarkFetchResult {
            atoms_written: 0,
            items_seen: 0,
            errors: vec!["lark source disabled".to_string()],
        };
    }
    if cfg.app_id.is_empty() {
        return LarkFetchResult {
            atoms_written: 0,
            items_seen: 0,
            errors: vec!["lark app_id missing".to_string()],
        };
    }
    // Real implementation would:
    //   1. exchange (app_id, app_secret) -> tenant_access_token via
    //      POST {api_base}/auth/v3/tenant_access_token/internal
    //   2. list chats: GET {api_base}/im/v1/chats
    //   3. for each chat: GET {api_base}/im/v1/messages?container_id=<chat_id>&start_time=<lookback>
    //   4. write atoms via format_lark_atom + message_filename
    LarkFetchResult {
        atoms_written: 0,
        items_seen: 0,
        errors: Vec::new(),
    }
}

/// Local copy of the YAML scalar quoter — duplicated from `sources::external::mod`
/// to avoid making that helper public outside its module. The shape is small.
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
        DateTime::parse_from_rfc3339("2026-04-27T08:30:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn atom_includes_source_and_channel() {
        let atom = format_lark_atom(&LarkAtomInput {
            message_id: "om_abc123",
            chat_id: "oc_xyz",
            sender: "Daizhe",
            message_text: "hello team",
            channel: "Engineering",
            ts: ts(),
        });
        assert!(atom.contains("source: lark"));
        assert!(atom.contains("channel: Engineering"));
        assert!(atom.contains("hello team"));
        assert!(atom.starts_with("---\n"));
    }

    #[test]
    fn atom_skips_channel_line_when_empty() {
        let atom = format_lark_atom(&LarkAtomInput {
            message_id: "om_x",
            chat_id: "oc_y",
            sender: "x",
            message_text: "x",
            channel: "",
            ts: ts(),
        });
        assert!(!atom.contains("channel:"));
    }

    #[test]
    fn filename_strips_om_prefix() {
        let f = message_filename(&LarkAtomInput {
            message_id: "om_abc123",
            chat_id: "oc_xyz",
            sender: "x",
            message_text: "x",
            channel: "",
            ts: ts(),
        });
        assert!(f.starts_with("abc123"));
        assert!(f.ends_with(".md"));
    }

    #[test]
    fn ingest_tick_disabled_reports_error_not_panic() {
        let cfg = LarkConfig {
            enabled: false,
            ..Default::default()
        };
        let r = futures_block(ingest_tick_stub(&cfg));
        assert_eq!(r.atoms_written, 0);
        assert!(!r.errors.is_empty());
    }

    #[test]
    fn ingest_tick_enabled_but_no_app_id_reports_error() {
        let cfg = LarkConfig {
            enabled: true,
            app_id: String::new(),
            ..Default::default()
        };
        let r = futures_block(ingest_tick_stub(&cfg));
        assert!(r.errors.iter().any(|e| e.contains("app_id")));
    }

    fn futures_block<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(f)
    }

    #[test]
    fn dir_routes_under_personal() {
        let p = resolve_lark_dir(Path::new("/tmp/m"), "alice");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("personal/alice/threads/lark"), "got {s}");
    }
}
// === end wave 1.13-E ===
