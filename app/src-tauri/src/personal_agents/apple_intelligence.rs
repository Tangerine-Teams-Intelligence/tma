//! v3.0 §1.10 — Apple Intelligence (macOS Shortcuts) post-action capture.
//!
//! Apple Intelligence runs on-device behind macOS Shortcuts. The user
//! installs a Tangerine Shortcut that posts the `(action, input_excerpt,
//! output_excerpt)` tuple to a localhost webhook. This module owns the
//! payload shape + atom write — the actual HTTP listener is owned by
//! the daemon HTTP route agent (Wave 2 sibling) at
//! `127.0.0.1:7717/agents/apple_intel/hook`, which forwards parsed
//! payloads here via [`process_action_payload`].
//!
//! **Platform gate.** macOS Shortcuts is macOS-only. On non-macOS the
//! [`platform_supported`] probe returns `false` and the public command
//! surface (registered in `commands::personal_agents`) returns
//! `platform_not_supported`. The atom-writing path itself stays
//! cross-platform — it's just dormant code on Windows/Linux until/if
//! Shortcuts ships there.
//!
//! **Stub default.** No webhook listener runs unless the user enables
//! the toggle in Settings AND installs the Tangerine Shortcut. Without
//! the latter no payload ever arrives, so the dormant module costs
//! nothing.
//!
//! Atom path: `<dest_root>/apple-intelligence/{action-id}.md`.
//! Frontmatter:
//!   - `source: apple-intelligence`
//!   - `action: <writing_tools|image_playground|...>` (best-effort)
//!   - `os_version: <reported by Shortcut>` (optional)

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    read_atom_source_mtime, render_atom, system_time_to_nanos, topic_from_first_message,
    PersonalAgentAtom, PersonalAgentCaptureResult,
};

/// Per-user Apple Intelligence webhook listener config. Both fields
/// default to non-binding values: `port = 7717` mirrors the daemon's
/// existing port; `secret` defaults empty so a fresh install never
/// rejects a payload by accident, but the Settings UI strongly hints at
/// configuring one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppleIntelligenceWebhook {
    /// Port the daemon's HTTP listener binds. Inherited from the v1.6
    /// ws_server pattern; the actual listener is owned by the daemon
    /// agent. Stored here so the module is self-describing and tests
    /// don't have to reach into the daemon.
    pub port: u16,
    /// Shared secret expected on the Shortcut's HTTP POST (e.g. as a
    /// `X-Tangerine-Secret` header). Empty ⇒ no validation. Production
    /// installs should always set this.
    pub secret: String,
}

impl Default for AppleIntelligenceWebhook {
    fn default() -> Self {
        Self {
            port: 7717,
            secret: String::new(),
        }
    }
}

/// One Shortcut post-action payload. The Shortcuts app posts a JSON
/// blob; missing fields fall back to defaults rather than reject.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ApplePostActionPayload {
    /// Stable id the Shortcut generates per action invocation. Required
    /// for atom keying. The Shortcut template uses
    /// `Get UUID Action -> Pass to webhook` so this is always present
    /// for installs of the official template.
    #[serde(default)]
    pub action_id: Option<String>,
    /// Which Apple Intelligence surface fired:
    /// `writing_tools | image_playground | genmoji | notification_summary | other`.
    #[serde(default)]
    pub action: Option<String>,
    /// First N chars of the user's input to the AI surface.
    #[serde(default)]
    pub input_excerpt: Option<String>,
    /// First N chars of the AI's output.
    #[serde(default)]
    pub output_excerpt: Option<String>,
    /// RFC 3339 timestamp the Shortcut stamped at post time.
    #[serde(default)]
    pub ts: Option<String>,
    /// Optional macOS version, e.g. "26.0.1".
    #[serde(default)]
    pub os_version: Option<String>,
}

/// True when the host can run Apple Intelligence captures. macOS only —
/// the rest of the public surface returns `platform_not_supported` when
/// this is false.
pub fn platform_supported() -> bool {
    cfg!(target_os = "macos")
}

pub fn apple_intelligence_dir(dest_root: &Path) -> PathBuf {
    dest_root.join("apple-intelligence")
}

pub fn detected(dest_root: &Path) -> bool {
    if !platform_supported() {
        return false;
    }
    let dir = apple_intelligence_dir(dest_root);
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
    if !platform_supported() {
        return 0;
    }
    let dir = apple_intelligence_dir(dest_root);
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

/// Process one Shortcut payload. Returns the standard capture result
/// shape so the daemon hook can log it uniformly. On non-macOS this
/// returns a single `platform_not_supported` error; the caller (the
/// HTTP listener) should reject the request before it ever reaches
/// here, but we double-gate so a misconfigured cross-machine sync can't
/// pollute a Windows user's vault.
pub fn process_action_payload(
    dest_root: &Path,
    payload: &ApplePostActionPayload,
) -> PersonalAgentCaptureResult {
    let mut result = PersonalAgentCaptureResult::empty("apple-intelligence");
    if !platform_supported() {
        result
            .errors
            .push("platform_not_supported: Apple Intelligence requires macOS".to_string());
        return result;
    }
    let target_dir = apple_intelligence_dir(dest_root);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        result
            .errors
            .push(format!("create_dir_all {}: {}", target_dir.display(), e));
        return result;
    }
    match build_atom_from_payload(payload) {
        Ok((atom, action_id)) => {
            let atom_path = target_dir.join(format!("{}.md", sanitize_id(&action_id)));
            if let Some(prev) = read_atom_source_mtime(&atom_path) {
                if prev >= atom.source_mtime_nanos && atom.source_mtime_nanos != 0 {
                    result.skipped += 1;
                    return result;
                }
            }
            match fs::write(
                &atom_path,
                render_atom_with_apple_extras(&atom, payload),
            ) {
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

/// Stub entry for the non-macOS path — used by the public Tauri command
/// so the React side can render a "platform not supported" row without
/// the command silently succeeding. Public so the command surface in
/// `commands::personal_agents` can call it directly without going
/// through the platform-gate inside [`process_action_payload`].
pub fn unsupported_platform_result() -> PersonalAgentCaptureResult {
    PersonalAgentCaptureResult {
        source: "apple-intelligence".to_string(),
        written: 0,
        skipped: 0,
        errors: vec!["platform_not_supported".to_string()],
    }
}

fn build_atom_from_payload(
    payload: &ApplePostActionPayload,
) -> Result<(PersonalAgentAtom, String), String> {
    let action_id = payload
        .action_id
        .clone()
        .ok_or_else(|| "missing action_id in payload".to_string())?;
    if action_id.trim().is_empty() {
        return Err("empty action_id in payload".into());
    }

    let topic = match (&payload.action, &payload.input_excerpt) {
        (Some(action), Some(input)) if !input.trim().is_empty() => {
            topic_from_first_message(&format!("{}: {}", action, input))
        }
        (Some(action), _) => topic_from_first_message(action),
        (None, Some(input)) => topic_from_first_message(input),
        (None, None) => topic_from_first_message(&format!("Apple Intelligence {}", action_id)),
    };

    let mtime_nanos = payload
        .ts
        .as_deref()
        .and_then(parse_rfc3339_to_nanos)
        .unwrap_or_else(|| system_time_to_nanos(std::time::SystemTime::now()));

    let mut body = String::new();
    if let Some(action) = payload.action.as_deref() {
        body.push_str(&format!("**Action**: `{}`\n\n", action));
    }
    if let Some(input) = payload.input_excerpt.as_deref() {
        if !input.trim().is_empty() {
            body.push_str("**User input**:\n");
            body.push_str(input.trim_end());
            body.push_str("\n\n");
        }
    }
    if let Some(output) = payload.output_excerpt.as_deref() {
        if !output.trim().is_empty() {
            body.push_str("**AI output**:\n");
            body.push_str(output.trim_end());
            body.push('\n');
        }
    }
    if body.trim().is_empty() {
        body.push_str(&format!(
            "Apple Intelligence action `{}` (no excerpts captured).\n",
            action_id
        ));
    }

    Ok((
        PersonalAgentAtom {
            source: "apple-intelligence".to_string(),
            conversation_id: action_id.clone(),
            started_at: payload.ts.clone(),
            ended_at: payload.ts.clone(),
            // Apple Intelligence is single-shot per action — input + output
            // is two "messages" for atom-shape parity with chat sources.
            message_count: payload
                .input_excerpt
                .as_ref()
                .map(|_| 1)
                .unwrap_or(0)
                + payload
                    .output_excerpt
                    .as_ref()
                    .map(|_| 1)
                    .unwrap_or(0),
            topic,
            source_mtime_nanos: mtime_nanos,
            body,
        },
        action_id,
    ))
}

fn render_atom_with_apple_extras(
    atom: &PersonalAgentAtom,
    payload: &ApplePostActionPayload,
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
            if let Some(action) = payload.action.as_deref() {
                if !action.trim().is_empty() {
                    out.push_str(&format!(
                        "action: {}\n",
                        super::yaml_scalar_pub(action)
                    ));
                }
            }
            if let Some(os) = payload.os_version.as_deref() {
                if !os.trim().is_empty() {
                    out.push_str(&format!(
                        "os_version: {}\n",
                        super::yaml_scalar_pub(os)
                    ));
                }
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
        // Defensive append (render_atom always closes its frontmatter,
        // but never lose the extras).
        out.push_str("\n<!-- apple-intelligence extras -->\n");
        if let Some(a) = &payload.action {
            out.push_str(&format!("action: {}\n", a));
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
        "action".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_returns_marker_error() {
        // Always available — used by the Tauri command on non-macOS.
        let r = unsupported_platform_result();
        assert_eq!(r.source, "apple-intelligence");
        assert_eq!(r.written, 0);
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0], "platform_not_supported");
    }

    #[test]
    fn process_action_payload_gates_on_platform() {
        // On non-macOS the function returns the platform error directly
        // without touching the filesystem. On macOS we expect the write
        // path to fire — we test the macOS path conditionally below.
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_apple_gate_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let payload = ApplePostActionPayload {
            action_id: Some("act-1".to_string()),
            action: Some("writing_tools".to_string()),
            input_excerpt: Some("draft this".to_string()),
            output_excerpt: Some("here you go".to_string()),
            ts: Some("2026-04-26T10:00:00Z".to_string()),
            ..Default::default()
        };
        let result = process_action_payload(&tmp, &payload);
        if platform_supported() {
            assert_eq!(result.written, 1, "errors: {:?}", result.errors);
            let body = fs::read_to_string(apple_intelligence_dir(&tmp).join("act-1.md"))
                .expect("atom should exist on macOS");
            assert!(body.contains("source: apple-intelligence"));
            assert!(body.contains("action: writing_tools"));
            assert!(body.contains("**User input**:"));
            assert!(body.contains("**AI output**:"));
        } else {
            assert_eq!(result.written, 0);
            assert_eq!(result.errors.len(), 1);
            assert!(result.errors[0].contains("platform_not_supported"));
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn payload_without_action_id_rejected() {
        // Run the inner builder directly so the test is platform-agnostic.
        let payload = ApplePostActionPayload::default();
        let r = build_atom_from_payload(&payload);
        assert!(r.is_err());
    }

    #[test]
    fn webhook_default_listens_on_daemon_port() {
        let cfg = AppleIntelligenceWebhook::default();
        assert_eq!(cfg.port, 7717);
        assert_eq!(cfg.secret, "");
    }

    #[test]
    fn detected_false_on_non_macos_or_empty_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "tii_pa_apple_det_{}",
            uuid::Uuid::new_v4().simple()
        ));
        // Default empty dir — detected stays false on every platform.
        let _ = fs::create_dir_all(apple_intelligence_dir(&tmp));
        assert!(!detected(&tmp));
        let _ = fs::remove_dir_all(&tmp);
    }
}
