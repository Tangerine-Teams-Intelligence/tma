//! v3.0 §1.11 — Microsoft Copilot personal capture (stub).
//!
//! Microsoft Copilot interactions live behind the Microsoft Graph API
//! (`https://graph.microsoft.com/v1.0/me/copilotActivity`) and require
//! an enterprise Copilot license to query. Per the Wave 2 brief this
//! module ships as a stub: the auth scaffolding + UI row + capture
//! entry points all exist so an enterprise customer (and the v3.5+
//! enterprise tier) can flip a single feature flag, but the default
//! path is "license required → empty result, no API call".
//!
//! **Real-mode flag.** [`MsCopilotConfig::is_stub`] returns `true`
//! whenever any of the three required fields (`tenant_id`, `client_id`,
//! `client_secret`) is empty. Production mode requires all three; even
//! then the Wave 2 implementation returns a `license_required` error
//! rather than fire a real Graph call.
//!
//! Atom path: `<dest_root>/ms-copilot/{activity-id}.md`. Frontmatter:
//!   - `source: ms-copilot`
//!   - `app: <Word|Excel|Teams|...>` (best-effort)
//!   - `tenant: <tenant-id>` (no secrets)

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Microsoft Graph App credentials. Stored alongside the rest of the
/// personal-agents config; secret persistence is handled by the daemon
/// agent via OS keychain. Empty strings ⇒ stub mode (no auth attempt).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct MsCopilotConfig {
    /// Microsoft Entra tenant id (the `directoryId` in Azure portal).
    #[serde(default)]
    pub tenant_id: String,
    /// App registration client id.
    #[serde(default)]
    pub client_id: String,
    /// App registration client secret (or pointer into OS keychain in
    /// real mode). Stored here as a string for the Wave 2 stub; the
    /// real-mode swap should move this into the daemon's keychain
    /// helper.
    #[serde(default)]
    pub client_secret: String,
}

impl MsCopilotConfig {
    /// Default mode unless ALL three Graph credentials are present.
    pub fn is_stub(&self) -> bool {
        self.tenant_id.trim().is_empty()
            || self.client_id.trim().is_empty()
            || self.client_secret.trim().is_empty()
    }
}

/// One Copilot activity record (subset of the Graph API shape — the
/// real surface is documented at
/// https://learn.microsoft.com/en-us/graph/api/resources/copilotinteraction
/// but the field set we actually need is small).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct MsCopilotActivity {
    /// Stable activity id — required for atom keying.
    #[serde(default)]
    pub id: Option<String>,
    /// Which Microsoft 365 surface fired the activity (Word, Excel,
    /// Teams, Outlook, ...).
    #[serde(default)]
    pub app: Option<String>,
    /// User prompt text.
    #[serde(default)]
    pub user_prompt: Option<String>,
    /// Copilot response text.
    #[serde(default)]
    pub copilot_response: Option<String>,
    /// RFC 3339 activity timestamp.
    #[serde(default)]
    pub timestamp: Option<String>,
}

/// Top-level Graph list response. Real Graph wraps the array in a
/// `{"value": [...]}` envelope; we accept either shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum MsCopilotListResponse {
    Wrapped {
        #[serde(default)]
        value: Vec<MsCopilotActivity>,
    },
    Bare(Vec<MsCopilotActivity>),
}

impl MsCopilotListResponse {
    pub fn into_activities(self) -> Vec<MsCopilotActivity> {
        match self {
            MsCopilotListResponse::Wrapped { value } => value,
            MsCopilotListResponse::Bare(v) => v,
        }
    }
}

pub fn ms_copilot_dir(dest_root: &Path) -> PathBuf {
    dest_root.join("ms-copilot")
}

pub fn detected(dest_root: &Path) -> bool {
    let dir = ms_copilot_dir(dest_root);
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

pub fn count_atoms(dest_root: &Path) -> usize {
    let dir = ms_copilot_dir(dest_root);
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

/// Stub-mode Graph poll. Returns:
///   - empty result (zero errors) when the config is in stub mode (no
///     credentials configured) — the strict opt-in default;
///   - single `license_required` error when credentials ARE configured
///     so the Settings UI can render "configured but enterprise license
///     required to capture".
///
/// The real-mode HTTP fetch + OAuth token exchange is intentionally
/// elided per the Wave 2 brief.
pub fn poll_recent(dest_root: &Path, config: &MsCopilotConfig) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("ms-copilot");
    let _ = fs::create_dir_all(ms_copilot_dir(dest_root));
    if config.is_stub() {
        return result;
    }
    result.errors.push(
        "license_required: Microsoft Copilot enterprise license needed to query Graph"
            .to_string(),
    );
    result
}

/// Process a Graph list response. Walks every activity, writes one
/// atom each. Used by the (future) real-mode HTTP fetcher and the unit
/// tests directly.
pub fn process_list_response(
    dest_root: &Path,
    response: MsCopilotListResponse,
    tenant_id: &str,
) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("ms-copilot");
    let target_dir = ms_copilot_dir(dest_root);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    for activity in response.into_activities() {
        match capture_one_activity(&target_dir, &activity, tenant_id) {
            Ok(true) => result.written += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => result.errors.push(e),
        }
    }
    result
}

fn capture_one_activity(
    target_dir: &Path,
    activity: &MsCopilotActivity,
    tenant_id: &str,
) -> Result<bool, String> {
    let activity_id = activity
        .id
        .clone()
        .ok_or_else(|| "missing activity id".to_string())?;
    if activity_id.trim().is_empty() {
        return Err("empty activity id".into());
    }

    let mtime_nanos = activity
        .timestamp
        .as_deref()
        .and_then(parse_rfc3339_to_nanos)
        .unwrap_or_else(|| system_time_to_nanos(std::time::SystemTime::now()));

    let atom_path = target_dir.join(format!("{}.md", sanitize_id(&activity_id)));
    if let Some(prev) = read_atom_source_mtime(&atom_path) {
        if prev >= mtime_nanos && mtime_nanos != 0 {
            return Ok(false);
        }
    }

    let topic = match (&activity.app, &activity.user_prompt) {
        (Some(app), Some(prompt)) if !prompt.trim().is_empty() => {
            topic_from_first_message(&format!("{}: {}", app, prompt))
        }
        (Some(app), _) => topic_from_first_message(app),
        (None, Some(prompt)) => topic_from_first_message(prompt),
        (None, None) => topic_from_first_message(&format!("MS Copilot {}", activity_id)),
    };

    let mut body = String::new();
    if let Some(prompt) = activity.user_prompt.as_deref() {
        if !prompt.trim().is_empty() {
            body.push_str(&format!("**User**: {}\n", prompt.trim_end()));
        }
    }
    if let Some(response) = activity.copilot_response.as_deref() {
        if !response.trim().is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("**Copilot**: {}\n", response.trim_end()));
        }
    }
    if body.trim().is_empty() {
        body.push_str(&format!(
            "MS Copilot activity `{}` (no excerpts captured).\n",
            activity_id
        ));
    }

    let message_count = activity.user_prompt.as_ref().map(|_| 1).unwrap_or(0)
        + activity.copilot_response.as_ref().map(|_| 1).unwrap_or(0);

    let atom = PersonalAgentAtom {
        source: "ms-copilot".to_string(),
        conversation_id: activity_id.clone(),
        started_at: activity.timestamp.clone(),
        ended_at: activity.timestamp.clone(),
        message_count,
        topic,
        source_mtime_nanos: mtime_nanos,
        body,
    };

    fs::write(&atom_path, render_atom_with_extras(&atom, activity, tenant_id))
        .map_err(|e| format!("write {}: {}", atom_path.display(), e))?;
    Ok(true)
}

fn render_atom_with_extras(
    atom: &PersonalAgentAtom,
    activity: &MsCopilotActivity,
    tenant_id: &str,
) -> String {
    let base = render_atom(atom);
    let mut out = String::with_capacity(base.len() + 128);
    let mut first_consumed = false;
    let mut close_done = false;
    for line in base.lines() {
        if !first_consumed && line == "---" {
            out.push_str(line);
            out.push('\n');
            first_consumed = true;
            continue;
        }
        if first_consumed && !close_done && line == "---" {
            if let Some(app) = activity.app.as_deref() {
                if !app.trim().is_empty() {
                    out.push_str(&format!("app: {}\n", super::yaml_scalar_pub(app)));
                }
            }
            if !tenant_id.trim().is_empty() {
                out.push_str(&format!(
                    "tenant: {}\n",
                    super::yaml_scalar_pub(tenant_id)
                ));
            }
            out.push_str(line);
            out.push('\n');
            close_done = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !close_done {
        out.push_str("\n<!-- ms-copilot extras -->\n");
        if let Some(app) = &activity.app {
            out.push_str(&format!("app: {}\n", app));
        }
        if !tenant_id.is_empty() {
            out.push_str(&format!("tenant: {}\n", tenant_id));
        }
    }
    out
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
        "activity".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_mode_default_off() {
        let cfg = MsCopilotConfig::default();
        assert!(cfg.is_stub(), "default config must be in stub mode");
    }

    #[test]
    fn partial_credentials_still_stub() {
        // Two of three fields filled — still stub.
        let cfg = MsCopilotConfig {
            tenant_id: "tenant-x".to_string(),
            client_id: "client-x".to_string(),
            client_secret: String::new(),
        };
        assert!(cfg.is_stub());
    }

    #[test]
    fn full_credentials_leave_stub_mode() {
        let cfg = MsCopilotConfig {
            tenant_id: "tenant-x".to_string(),
            client_id: "client-x".to_string(),
            client_secret: "secret-x".to_string(),
        };
        assert!(!cfg.is_stub());
    }

    #[test]
    fn poll_recent_stub_silent_noop() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_msc_stub_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = MsCopilotConfig::default();
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        assert!(result.errors.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn poll_recent_real_mode_returns_license_required() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_msc_real_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg = MsCopilotConfig {
            tenant_id: "t".to_string(),
            client_id: "c".to_string(),
            client_secret: "s".to_string(),
        };
        let result = poll_recent(&tmp, &cfg);
        assert_eq!(result.written, 0);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("license_required"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn process_list_response_writes_one_atom_per_activity() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_msc_two_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let response = MsCopilotListResponse::Wrapped {
            value: vec![
                MsCopilotActivity {
                    id: Some("a1".to_string()),
                    app: Some("Word".to_string()),
                    user_prompt: Some("rewrite this".to_string()),
                    copilot_response: Some("done".to_string()),
                    timestamp: Some("2026-04-26T10:00:00Z".to_string()),
                },
                MsCopilotActivity {
                    id: Some("a2".to_string()),
                    app: Some("Teams".to_string()),
                    timestamp: Some("2026-04-26T11:00:00Z".to_string()),
                    ..Default::default()
                },
            ],
        };
        let result = process_list_response(&tmp, response, "tenant-x");
        assert_eq!(result.written, 2, "errors: {:?}", result.errors);
        let dir = ms_copilot_dir(&tmp);
        assert!(dir.join("a1.md").is_file());
        assert!(dir.join("a2.md").is_file());

        let body1 = fs::read_to_string(dir.join("a1.md")).unwrap();
        assert!(body1.contains("source: ms-copilot"));
        assert!(body1.contains("app: Word"));
        assert!(body1.contains("tenant: tenant-x"));
        assert!(body1.contains("**User**: rewrite this"));
        assert!(body1.contains("**Copilot**: done"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
