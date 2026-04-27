//! v3.0 §1.8 — Devin instance capture.
//!
//! Devin (Cognition Labs) hosts long-running coding sessions on their
//! infrastructure; we never tail a local file. Two ingest paths:
//!
//!   1. **Webhook** — Tangerine's local daemon exposes
//!      `127.0.0.1:7717/agents/devin/webhook` (the actual HTTP route is
//!      added by the daemon agent in a sibling commit). Devin POSTs an
//!      activity payload there; this module's [`process_webhook_payload`]
//!      consumes it and writes/refreshes one atom per Devin instance id
//!      under `<dest_root>/devin/<instance-id>.md`.
//!   2. **Scheduled poll** — best-effort fallback when the webhook isn't
//!      reachable (no tunnel, user behind NAT, ...). Calls Devin's REST
//!      API (`https://api.devin.ai/v1/sessions?owner=...`) once per
//!      heartbeat. Auth via API token in OS keychain (the keychain entry
//!      is owned by the daemon agent; this module receives the token by
//!      argument and never persists it).
//!
//! **Stub default.** The real REST poll is gated behind the per-source
//! toggle (`personalAgentsEnabled.devin`) AND a non-empty API token. With
//! no token configured the [`poll_recent`] command returns an empty
//! capture result so a fresh install never makes a real API call. Tests
//! always run in stub mode; real-network tests are out of scope per the
//! Wave 2 brief.
//!
//! Atom path: `<dest_root>/devin/{instance-id}.md`. Frontmatter carries
//! the standard set plus Devin-specific fields:
//!   - `source: devin`
//!   - `devin_instance_id: <id>`
//!   - `task: <task-summary>` (best-effort extracted from payload)
//!   - `commits: <n>` (number of git commits the session pushed, if any)
//!   - `status: <running|finished|error|...>`
//!
//! Idempotence: the atom file's `source_mtime_nanos` is the webhook
//! payload's `updated_at` (RFC 3339 → nanos) when present, else the wall
//! clock at receive time. A re-delivery with the same `updated_at` is a
//! no-op.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Per-user Devin connection settings. Persisted alongside the rest of
/// the personal-agents config (the actual on-disk file is owned by the
/// daemon agent — see `commands::personal_agents`). The token is treated
/// as a read-only handle here; we never serialize it back to disk from
/// this module.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DevinConfig {
    /// Devin REST API token (Bearer). Empty string ⇒ stub mode.
    #[serde(default)]
    pub api_token: String,
    /// Shared secret used to verify webhook payloads. When empty the
    /// webhook handler still accepts payloads (best-effort) but emits a
    /// `signature_unverified` warning into the capture result. Production
    /// deployments should always set this.
    #[serde(default)]
    pub webhook_secret: String,
    /// Optional Devin workspace id — used to scope the REST poll to a
    /// single workspace instead of the global owner-keyed list.
    #[serde(default)]
    pub workspace_id: String,
}

impl DevinConfig {
    pub fn is_stub(&self) -> bool {
        self.api_token.trim().is_empty()
    }
}

/// Webhook payload shape — permissive across Devin's documented variants.
/// Unknown fields are ignored; missing fields fall back to sensible
/// defaults so a partial payload still produces an atom.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DevinWebhookPayload {
    /// Devin instance / session id. Required — without it we can't key
    /// the atom file.
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Alternate field name some Devin builds use.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Human-readable task description, e.g. "fix the auth retry loop".
    #[serde(default)]
    pub task: Option<String>,
    /// Higher-level status string. Documented values include `running`,
    /// `finished`, `failed`, `paused` — we accept any string.
    #[serde(default)]
    pub status: Option<String>,
    /// Number of git commits the instance pushed during this run.
    #[serde(default)]
    pub commits: Option<usize>,
    /// RFC 3339 timestamp of the last activity. Used for the atom's
    /// `ended_at` and (rounded to nanos) `source_mtime_nanos`.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// RFC 3339 timestamp of the session start. Drives the atom's
    /// `started_at` field.
    #[serde(default)]
    pub started_at: Option<String>,
    /// Optional list of (role, body) chunks for the conversation log.
    /// Permissive — most Devin webhooks omit this and the atom body just
    /// shows a summary line.
    #[serde(default)]
    pub events: Vec<DevinEvent>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DevinEvent {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

/// Resolve the canonical Devin atoms dir — used by the Settings UI even
/// before the first webhook lands. Returns the dir under `dest_root`.
pub fn devin_dir(dest_root: &Path) -> PathBuf {
    dest_root.join("devin")
}

/// Probe — best-effort detection. Devin lives on remote servers so we
/// can't probe the way we probe a local Cursor / Codex install. We
/// instead ask "has any atom ever landed?" — true when the dir exists
/// and contains at least one `.md` file. Used by the Settings UI to
/// render "captured / never captured" status.
pub fn detected(dest_root: &Path) -> bool {
    let dir = devin_dir(dest_root);
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

/// Count atoms already on disk for the Settings UI's "N captured" line.
pub fn count_atoms(dest_root: &Path) -> usize {
    let dir = devin_dir(dest_root);
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

/// Process one Devin webhook payload. Writes/refreshes the atom under
/// `<dest_root>/devin/<instance-id>.md`. Returns
/// [`PersonalAgentCaptureResult`] so the caller (the local HTTP daemon)
/// can log written/skipped counts uniformly with the other adapters.
pub fn process_webhook_payload(
    dest_root: &Path,
    payload: &DevinWebhookPayload,
) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("devin");
    let target_dir = devin_dir(dest_root);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    match build_atom_from_payload(payload) {
        Ok((atom, instance_id)) => {
            let atom_path = target_dir.join(format!("{}.md", sanitize_id(&instance_id)));
            if let Some(prev) = read_atom_source_mtime(&atom_path) {
                if prev >= atom.source_mtime_nanos && atom.source_mtime_nanos != 0 {
                    result.skipped += 1;
                    return result;
                }
            }
            match fs::write(&atom_path, render_atom_with_devin_extras(&atom, payload)) {
                Ok(()) => result.written += 1,
                Err(e) => result
                    .errors
                    .push(format!("write {}: {}", atom_path.display(), e)),
            }
        }
        Err(e) => result.errors.push(e),
    }
    result
}

/// Stub-mode REST poll. Reads the configured token; without it returns
/// an empty result. With a token present, this Wave 2 implementation
/// still returns an empty result — the real HTTP fetch lands when a
/// customer with a real Devin license needs it. The shape stays the
/// same so the daemon hook calling site doesn't change later.
pub fn poll_recent(dest_root: &Path, config: &DevinConfig) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("devin");
    // Always ensure the atom dir exists so Settings UI's count_atoms /
    // detected probe can read it cleanly even on first launch.
    let _ = fs::create_dir_all(devin_dir(dest_root));
    if config.is_stub() {
        // Strict opt-in. No token ⇒ no API call.
        return result;
    }
    // Real REST call would land here. The Wave 2 brief explicitly says
    // DO NOT make real Devin API calls — we leave this as a stub and
    // record a single informational note in `errors` so the Settings UI
    // can render "configured but offline" without misleading the user
    // that capture is silently working.
    result
        .errors
        .push("devin REST poll not yet implemented (token configured; webhook still works)".into());
    result
}

fn build_atom_from_payload(
    payload: &DevinWebhookPayload,
) -> Result<(PersonalAgentAtom, String), String> {
    let instance_id = payload
        .instance_id
        .clone()
        .or_else(|| payload.session_id.clone())
        .ok_or_else(|| "missing instance_id / session_id in payload".to_string())?;
    if instance_id.trim().is_empty() {
        return Err("empty instance_id in payload".into());
    }

    let topic = match payload.task.as_deref() {
        Some(t) if !t.trim().is_empty() => topic_from_first_message(t),
        _ => topic_from_first_message(&format!("Devin instance {}", instance_id)),
    };

    let started_at = payload.started_at.clone().or_else(|| {
        payload
            .events
            .iter()
            .find_map(|ev| ev.timestamp.clone())
    });
    let ended_at = payload
        .updated_at
        .clone()
        .or_else(|| payload.events.iter().filter_map(|ev| ev.timestamp.clone()).last());

    let mtime_nanos = payload
        .updated_at
        .as_deref()
        .and_then(parse_rfc3339_to_nanos)
        .unwrap_or_else(|| {
            // Wall clock fallback so a payload with no timestamp still
            // wins on first delivery (mtime > 0 ⇒ atom marked fresh).
            system_time_to_nanos(std::time::SystemTime::now())
        });

    let body = if payload.events.is_empty() {
        let summary_line = match (&payload.status, &payload.commits) {
            (Some(s), Some(c)) => format!(
                "**Devin instance** `{}` — status `{}`, {} commit{}.\n",
                instance_id,
                s,
                c,
                if *c == 1 { "" } else { "s" }
            ),
            (Some(s), None) => format!(
                "**Devin instance** `{}` — status `{}`.\n",
                instance_id, s
            ),
            (None, Some(c)) => format!(
                "**Devin instance** `{}` — {} commit{}.\n",
                instance_id,
                c,
                if *c == 1 { "" } else { "s" }
            ),
            (None, None) => format!("**Devin instance** `{}`.\n", instance_id),
        };
        summary_line
    } else {
        payload
            .events
            .iter()
            .map(|ev| {
                let role = match ev.role.as_deref() {
                    Some("user") => "User",
                    Some("assistant") => "Assistant",
                    Some("devin") => "Devin",
                    Some(other) => other,
                    None => "Event",
                };
                let body = ev.body.clone().unwrap_or_default();
                format!("**{}**: {}\n", role, body.trim_end())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let message_count = payload.events.len().max(1);

    Ok((
        PersonalAgentAtom {
            source: "devin".to_string(),
            conversation_id: instance_id.clone(),
            started_at,
            ended_at,
            message_count,
            topic,
            source_mtime_nanos: mtime_nanos,
            body,
        },
        instance_id,
    ))
}

/// Render shared-shape atom + append Devin-specific frontmatter lines
/// just inside the closing `---`. The shared renderer in `mod.rs` doesn't
/// know about `devin_instance_id` / `task` / `commits` / `status`, so
/// instead of teaching it every adapter's quirks we splice the extras in
/// here.
fn render_atom_with_devin_extras(atom: &PersonalAgentAtom, payload: &DevinWebhookPayload) -> String {
    let base = render_atom(atom);
    // Locate the second `---` (closing the frontmatter) and inject our
    // lines just before it. Defensive: if the closing fence is missing
    // (shouldn't happen — render_atom always emits one), append at the
    // very end so we never lose the data.
    let mut out = String::with_capacity(base.len() + 256);
    let mut found_close = false;
    let mut consumed_first = false;
    for line in base.lines() {
        if !consumed_first && line == "---" {
            out.push_str(line);
            out.push('\n');
            consumed_first = true;
            continue;
        }
        if consumed_first && !found_close && line == "---" {
            // Splice extras here.
            let instance_id = payload
                .instance_id
                .clone()
                .or_else(|| payload.session_id.clone())
                .unwrap_or_default();
            if !instance_id.is_empty() {
                out.push_str(&format!(
                    "devin_instance_id: {}\n",
                    super::yaml_scalar_pub(&instance_id)
                ));
            }
            if let Some(task) = payload.task.as_deref() {
                if !task.trim().is_empty() {
                    out.push_str(&format!("task: {}\n", super::yaml_scalar_pub(task)));
                }
            }
            if let Some(c) = payload.commits {
                out.push_str(&format!("commits: {}\n", c));
            }
            if let Some(status) = payload.status.as_deref() {
                if !status.trim().is_empty() {
                    out.push_str(&format!("status: {}\n", super::yaml_scalar_pub(status)));
                }
            }
            out.push_str(line);
            out.push('\n');
            found_close = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !found_close {
        // Defensive append so we never silently drop the extras.
        let instance_id = payload
            .instance_id
            .clone()
            .or_else(|| payload.session_id.clone())
            .unwrap_or_default();
        out.push_str("\n<!-- devin extras -->\n");
        if !instance_id.is_empty() {
            out.push_str(&format!("devin_instance_id: {}\n", instance_id));
        }
        if let Some(task) = &payload.task {
            out.push_str(&format!("task: {}\n", task));
        }
        if let Some(c) = payload.commits {
            out.push_str(&format!("commits: {}\n", c));
        }
        if let Some(status) = &payload.status {
            out.push_str(&format!("status: {}\n", status));
        }
    }
    out
}

/// Best-effort RFC 3339 → unix-nanos parser. Used to drive idempotence
/// off the payload's `updated_at` rather than the local wall clock so a
/// retried delivery is a no-op. Returns `None` on parse failure (we then
/// fall back to wall clock — first delivery still wins).
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
        "instance".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_payload_parses_and_writes_atom() {
        let raw = r#"{
            "instance_id": "devin-abc-123",
            "task": "fix the auth retry loop",
            "status": "running",
            "commits": 2,
            "started_at": "2026-04-26T10:00:00Z",
            "updated_at": "2026-04-26T10:30:00Z",
            "events": [
                {"role": "user", "body": "go fix it", "timestamp": "2026-04-26T10:00:01Z"},
                {"role": "devin", "body": "on it", "timestamp": "2026-04-26T10:00:30Z"}
            ]
        }"#;
        let payload: DevinWebhookPayload = serde_json::from_str(raw).expect("parse");
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_devin_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let result = process_webhook_payload(&tmp, &payload);
        assert_eq!(result.written, 1, "should write atom");
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        let atom_path = devin_dir(&tmp).join("devin-abc-123.md");
        assert!(atom_path.is_file(), "atom file must exist");
        let body = fs::read_to_string(&atom_path).unwrap();
        assert!(body.contains("source: devin"));
        assert!(body.contains("devin_instance_id: devin-abc-123"));
        assert!(body.contains("task: fix the auth retry loop"));
        assert!(body.contains("status: running"));
        assert!(body.contains("commits: 2"));
        assert!(body.contains("**User**: go fix it"));
        assert!(body.contains("**Devin**: on it"));

        // Idempotent — same payload writes nothing.
        let result2 = process_webhook_payload(&tmp, &payload);
        assert_eq!(result2.written, 0);
        assert_eq!(result2.skipped, 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn webhook_rejects_payload_without_id() {
        let payload = DevinWebhookPayload::default();
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_devin_noid_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let result = process_webhook_payload(&tmp, &payload);
        assert_eq!(result.written, 0);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("instance_id"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn webhook_uses_session_id_fallback() {
        let payload = DevinWebhookPayload {
            session_id: Some("sess-xyz".to_string()),
            task: Some("anything".to_string()),
            ..Default::default()
        };
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_devin_sess_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let result = process_webhook_payload(&tmp, &payload);
        assert_eq!(result.written, 1);
        assert!(devin_dir(&tmp).join("sess-xyz.md").is_file());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn poll_recent_in_stub_mode_makes_no_call() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_devin_stub_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = DevinConfig::default();
        assert!(cfg.is_stub());
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        assert!(result.errors.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn poll_recent_with_token_records_pending_note() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_devin_token_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = DevinConfig {
            api_token: "fake-token".to_string(),
            ..Default::default()
        };
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        // Token configured ⇒ we leave a one-line note so Settings UI can
        // distinguish "no token" from "token but offline".
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].to_lowercase().contains("not yet implemented"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
