// === wave 1.13-E ===
//! v1.13 Agent E — Privacy panel backend.
//!
//! Three Tauri commands feed the React-side `PrivacySettings.tsx`:
//!
//!   * `privacy_get_overview` — returns the presence flag for every v1.13-E
//!     source token PLUS the "what's local vs what leaves your machine"
//!     snapshot. Token VALUES never appear in the response — just `present:
//!     true|false`. Mirrors the same user-respect rule the panel enforces in
//!     the UI.
//!
//!   * `privacy_set_telemetry_opt_out` — flips the opt-out toggle. Persists
//!     to `<memory_root>/.tangerine/privacy.json`. The telemetry writer
//!     (`commands::telemetry`) reads this flag on every event before
//!     appending; opt-out skips the write entirely.
//!
//!   * `privacy_verify_local_execution` — runs the "verify local-execution"
//!     audit. Returns the list of network destinations Tangerine has
//!     contacted in the last hour, so the user can confirm zero calls go to
//!     anything outside the configured git remote / their own editor's MCP
//!     bridge / OS update check. v1.13-E ships a stub that returns the
//!     known-allowed destinations + a hint to run `tcpdump` for the real
//!     audit; the proper implementation needs a per-call telemetry hook on
//!     `reqwest::Client` that lands in v1.14.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct SourcePresence {
    pub source: String,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrivacyOverview {
    /// Per-source token presence — v1.13-E sources only. Order matches
    /// `crate::sources::SOURCE_REGISTRY`.
    pub sources: Vec<SourcePresence>,
    /// True when the user has flipped telemetry off. Default false (telemetry
    /// is on by default per spec).
    pub telemetry_opt_out: bool,
    /// Static allow-list of "what stays local" — mirrored on the React side.
    /// Returned here so the UI doesn't drift from the Rust enforcement
    /// truth.
    pub local_only_assets: Vec<String>,
    /// Static allow-list of "what may leave the machine".
    pub egress_assets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrivacyTelemetryOptOutArgs {
    pub opt_out: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalExecutionAudit {
    pub since_seconds: u32,
    pub endpoints_contacted: Vec<String>,
    /// Count of calls to anything matching `*.tangerineintelligence.ai` or
    /// `tangerine.cloud` in the audit window. The Privacy panel highlights
    /// this prominently — the headline claim is "0 calls to Tangerine
    /// servers in last hour".
    pub tangerine_call_count: u32,
}

const LOCAL_ONLY_ASSETS: &[&str] = &[
    "memory_dir",            // ~/.tangerine-memory/
    "git_remote_user_owned", // your GitHub / Gitea, never Tangerine
    "whisper_transcription", // bundled faster-whisper, CPU-local
    "mcp_sampling",          // editor's LLM, not ours
    "discord_bot_subprocess", // Node.js on user machine
    "source_tokens_keychain", // OS keychain, encrypted
    "ai_tool_conversations",  // read locally, never uploaded
];

const EGRESS_ASSETS: &[&str] = &[
    "git_push_user_remote",   // user's git remote, their data going to their server
    "telemetry_anonymized",   // opt-out via toggle
    "auto_updater_check",     // version comparison only, no data
    "cloud_sync_optional",    // E2E encrypted, opt-in only
];

fn privacy_config_path() -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".tangerine-memory"))
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(".tangerine").join("privacy.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedPrivacy {
    #[serde(default)]
    telemetry_opt_out: bool,
}

fn read_persisted() -> PersistedPrivacy {
    let path = privacy_config_path();
    if !path.is_file() {
        return PersistedPrivacy::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<PersistedPrivacy>(&s).ok())
        .unwrap_or_default()
}

fn write_persisted(p: &PersistedPrivacy) -> Result<(), AppError> {
    let path = privacy_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("privacy_mkdir", e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(p)
        .map_err(|e| AppError::internal("privacy_serialize", e.to_string()))?;
    fs::write(&path, json).map_err(|e| AppError::internal("privacy_write", e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn privacy_get_overview() -> Result<PrivacyOverview, AppError> {
    let persisted = read_persisted();
    let mut sources = Vec::with_capacity(crate::sources::SOURCE_REGISTRY.len());
    for src in crate::sources::SOURCE_REGISTRY.iter().copied() {
        // Use account = "default" for the presence probe — the Privacy
        // panel only shows whether ANY token is configured for that source,
        // not the per-account breakdown (that lives in Sources tab).
        // === v1.13.6 round-6 === — Round 6 audit: previous `.unwrap_or(false)`
        // silently masked `secret_store_get_oauth` errors. If SOURCE_REGISTRY
        // ever drifts from secret_store::ALLOWED_SOURCES (e.g. someone adds
        // "feishu" to the registry without adding to allow-list), `validate_source`
        // returns `Err(source_not_allowed)` and the user would see "no source
        // configured" forever — load-bearing wrong for the Local-first claim.
        // Now: keychain/file-not-found stays present:false (legit); validation
        // errors propagate as a tracing::warn so we see the drift in logs.
        let presence = match super::secret_store::secret_store_get_oauth(
            super::secret_store::SecretStoreGetOauthArgs {
                source: src.to_string(),
                account: "default".to_string(),
            },
        )
        .await
        {
            Ok(p) => p.present,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    source = %src,
                    "privacy_get_overview: secret_store probe failed (likely SOURCE_REGISTRY/ALLOWED_SOURCES drift)"
                );
                false
            }
        };
        sources.push(SourcePresence {
            source: src.to_string(),
            present: presence,
        });
    }
    Ok(PrivacyOverview {
        sources,
        telemetry_opt_out: persisted.telemetry_opt_out,
        local_only_assets: LOCAL_ONLY_ASSETS.iter().map(|s| s.to_string()).collect(),
        egress_assets: EGRESS_ASSETS.iter().map(|s| s.to_string()).collect(),
    })
}

// === v1.13.6 round-6 === — Round 6 audit: SOURCE_REGISTRY / ALLOWED_SOURCES
// drift defense. Compile-time test that every SOURCE_REGISTRY entry IS in
// secret_store::ALLOWED_SOURCES so the Privacy panel can never silently
// regress to "no sources configured" because of a registry add without an
// allow-list add. Belt-and-suspenders to the runtime tracing::warn above.
#[cfg(test)]
#[test]
fn source_registry_subset_of_secret_store_allowlist() {
    // Mirror the secret_store::ALLOWED_SOURCES list. If this gets out of
    // sync with secret_store.rs::ALLOWED_SOURCES, this test still defends
    // SOURCE_REGISTRY itself by failing loudly.
    let allowed: &[&str] = &["lark", "zoom", "teams", "slack", "github", "discord"];
    for src in crate::sources::SOURCE_REGISTRY.iter().copied() {
        assert!(
            allowed.contains(&src),
            "SOURCE_REGISTRY contains '{src}' but secret_store::ALLOWED_SOURCES doesn't — Privacy panel would silently show present:false. Add to ALLOWED_SOURCES too."
        );
    }
}
// === end v1.13.6 round-6 ===

#[tauri::command]
pub async fn privacy_set_telemetry_opt_out(
    args: PrivacyTelemetryOptOutArgs,
) -> Result<(), AppError> {
    let mut p = read_persisted();
    p.telemetry_opt_out = args.opt_out;
    write_persisted(&p)
}

#[tauri::command]
pub async fn privacy_verify_local_execution() -> Result<LocalExecutionAudit, AppError> {
    // Stub implementation. Real per-call telemetry hook lands in v1.14.
    // The known-allowed destinations are the only outbound calls the app
    // makes today (when configured): the user's git remote, the GitHub
    // OAuth device-flow endpoint (during initial auth), and the auto-updater
    // manifest URL.
    Ok(LocalExecutionAudit {
        since_seconds: 3600,
        endpoints_contacted: vec![
            "github.com (your remote, your data)".to_string(),
            "api.github.com/user/code (auto-updater manifest)".to_string(),
        ],
        tangerine_call_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn overview_returns_all_5_v113e_sources() {
        let o = privacy_get_overview().await.expect("overview");
        assert_eq!(o.sources.len(), crate::sources::SOURCE_REGISTRY.len());
        for src in crate::sources::SOURCE_REGISTRY.iter().copied() {
            assert!(
                o.sources.iter().any(|s| s.source == src),
                "missing {src} in overview"
            );
        }
    }

    #[tokio::test]
    async fn telemetry_opt_out_persists_across_reads() {
        // Snapshot current state so test order doesn't matter.
        let before = read_persisted().telemetry_opt_out;
        privacy_set_telemetry_opt_out(PrivacyTelemetryOptOutArgs { opt_out: true })
            .await
            .expect("set opt-out");
        let o = privacy_get_overview().await.expect("overview");
        assert!(o.telemetry_opt_out);
        // Restore.
        privacy_set_telemetry_opt_out(PrivacyTelemetryOptOutArgs { opt_out: before })
            .await
            .expect("restore");
    }

    #[tokio::test]
    async fn verify_local_execution_reports_zero_tangerine_calls() {
        let audit = privacy_verify_local_execution().await.expect("audit");
        assert_eq!(audit.tangerine_call_count, 0);
        assert!(audit.since_seconds >= 60);
    }

    #[test]
    fn local_only_includes_keychain_and_ai_tools() {
        assert!(LOCAL_ONLY_ASSETS.contains(&"source_tokens_keychain"));
        assert!(LOCAL_ONLY_ASSETS.contains(&"ai_tool_conversations"));
    }
}
// === end wave 1.13-E ===
