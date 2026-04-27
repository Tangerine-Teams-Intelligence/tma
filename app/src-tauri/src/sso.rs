//! v3.5 §5.1 — SSO SAML scaffold (stub mode).
//!
//! Two providers prioritized for v3.5: Okta + Azure AD (~80% of F500 per
//! `V3_5_SPEC.md` §5.1). Google Workspace SSO deferred to v3.6.
//!
//! v3.5 stub mode: this module does NOT implement real SAML 2.0 — neither
//! signed-response verification nor encrypted assertion handling. The real
//! integration lands in the v3.5 production cut via `keycloak-rs` or
//! WorkOS once the §8 legal blockers close.
//!
//! The stub:
//!   * persists per-tenant `SSOConfig` to
//!     `~/.tangerine-memory/.tangerine/sso/<tenant>.json`
//!   * `validate_saml_response` returns a deterministic mock
//!     `SAMLAssertion` so the React provisioning UI can demo the JIT
//!     create-user flow without a real IdP wired up
//!
//! Spec note: Google Workspace SSO is explicitly NOT in v3.5 — v3.6 deferred.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// Supported SAML identity providers in v3.5. The provider field is a
/// string-typed enum so a future v3.6 `GoogleWorkspace` variant doesn't
/// invalidate persisted configs from v3.5.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SSOProvider {
    #[serde(rename = "okta")]
    Okta,
    #[serde(rename = "azure_ad")]
    AzureAD,
}

impl SSOProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            SSOProvider::Okta => "okta",
            SSOProvider::AzureAD => "azure_ad",
        }
    }
}

/// Per-tenant SAML SP metadata. Stored separately from `BrandingConfig`
/// because the IdP-side wiring (metadata URL exchange, SP entity id
/// registration) is independent of the visual override.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SSOConfig {
    pub provider: SSOProvider,
    /// IdP metadata URL — the SP fetches signing certificates + SSO endpoint
    /// from this on every login per SAML 2.0 §3.4.
    pub metadata_url: String,
    /// SP entity id — the unique handle the IdP knows us by.
    pub sp_entity_id: String,
    /// Tenant id this config belongs to. Used as the storage key.
    pub tenant: String,
}

/// Stub assertion returned by `validate_saml_response`. The real production
/// path returns this same shape after parsing the IdP's response, so the
/// frontend's JIT-provisioning code can flip from stub→real with no
/// changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SAMLAssertion {
    /// User's email address — used as the JIT-provisioned account's id.
    pub email: String,
    /// IdP-asserted display name.
    pub display_name: String,
    /// Tenant the assertion is bound to.
    pub tenant: String,
    /// IdP that issued the assertion.
    pub provider: SSOProvider,
    /// Roles the IdP attached to this user (for role-mapping per §5.1).
    pub roles: Vec<String>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn sso_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join(".tangerine").join("sso");
    fs::create_dir_all(&dir).map_err(|e| AppError::internal("sso_mkdir", e.to_string()))?;
    Ok(dir)
}

fn config_path(memory_root: &Path, tenant: &str) -> Result<PathBuf, AppError> {
    if tenant.is_empty() || tenant.contains('/') || tenant.contains('\\') {
        return Err(AppError::user(
            "sso_bad_tenant",
            format!("tenant '{}' contains invalid characters", tenant),
        ));
    }
    Ok(sso_dir(memory_root)?.join(format!("{}.json", tenant)))
}

pub fn write_config(memory_root: &Path, cfg: &SSOConfig) -> Result<(), AppError> {
    let path = config_path(memory_root, &cfg.tenant)?;
    let raw = serde_json::to_string_pretty(cfg)?;
    fs::write(&path, raw).map_err(|e| AppError::internal("sso_write", e.to_string()))?;
    Ok(())
}

pub fn read_config(memory_root: &Path, tenant: &str) -> Result<Option<SSOConfig>, AppError> {
    let path = config_path(memory_root, tenant)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::internal("sso_read", e.to_string()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&raw)?))
}

pub fn list_configs(memory_root: &Path) -> Result<Vec<SSOConfig>, AppError> {
    let dir = sso_dir(memory_root)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|e| AppError::internal("sso_listdir", e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Ok(cfg) = serde_json::from_str::<SSOConfig>(&raw) {
            out.push(cfg);
        }
    }
    Ok(out)
}

/// Stub SAML validator. v3.5 does NOT verify the response — we deliberately
/// return a mock assertion so the React provisioning UI can exercise the
/// JIT create-user flow end-to-end without a real IdP. Real validation
/// (signature check, NotBefore/NotOnOrAfter, audience, encrypted-assertion
/// decryption) lives behind the production cutover. Until then, `response`
/// is treated as opaque test data — only its emptiness is checked.
pub fn validate_saml_response(
    memory_root: &Path,
    tenant: &str,
    response: &str,
) -> Result<SAMLAssertion, AppError> {
    if response.trim().is_empty() {
        return Err(AppError::user(
            "sso_empty_response",
            "SAML response was empty",
        ));
    }
    let cfg = read_config(memory_root, tenant)?.ok_or_else(|| {
        AppError::user(
            "sso_unknown_tenant",
            format!("no SSO config for tenant '{}'", tenant),
        )
    })?;
    Ok(SAMLAssertion {
        email: format!("user@{}.tangerine-cloud.com", tenant),
        display_name: format!("Test User ({})", tenant),
        tenant: tenant.to_string(),
        provider: cfg.provider,
        roles: vec!["member".to_string()],
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let p = std::env::temp_dir().join(format!("ti-sso-{}", id));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample_config(tenant: &str) -> SSOConfig {
        SSOConfig {
            provider: SSOProvider::Okta,
            metadata_url: format!("https://acme.okta.com/app/{}/sso/saml/metadata", tenant),
            sp_entity_id: format!("urn:tangerine:{}", tenant),
            tenant: tenant.to_string(),
        }
    }

    #[test]
    fn provider_serializes_as_snake_case() {
        let okta = serde_json::to_string(&SSOProvider::Okta).unwrap();
        assert_eq!(okta, "\"okta\"");
        let azure = serde_json::to_string(&SSOProvider::AzureAD).unwrap();
        assert_eq!(azure, "\"azure_ad\"");
    }

    #[test]
    fn provider_as_str_stable_keys() {
        assert_eq!(SSOProvider::Okta.as_str(), "okta");
        assert_eq!(SSOProvider::AzureAD.as_str(), "azure_ad");
    }

    #[test]
    fn write_then_read_config_round_trips() {
        let root = TempDir::new();
        let cfg = sample_config("acme");
        write_config(root.path(), &cfg).unwrap();
        let loaded = read_config(root.path(), "acme").unwrap().unwrap();
        assert_eq!(loaded, cfg);
    }

    #[test]
    fn read_unknown_tenant_returns_none() {
        let root = TempDir::new();
        let loaded = read_config(root.path(), "nope").unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn list_returns_every_persisted_config() {
        let root = TempDir::new();
        write_config(root.path(), &sample_config("acme")).unwrap();
        write_config(root.path(), &sample_config("globex")).unwrap();
        let mut all = list_configs(root.path()).unwrap();
        all.sort_by(|a, b| a.tenant.cmp(&b.tenant));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].tenant, "acme");
        assert_eq!(all[1].tenant, "globex");
    }

    #[test]
    fn rejects_tenant_with_path_traversal() {
        let root = TempDir::new();
        let cfg = sample_config("../escape");
        let err = write_config(root.path(), &cfg).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_bad_tenant"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn validate_saml_returns_mock_assertion() {
        let root = TempDir::new();
        write_config(root.path(), &sample_config("acme")).unwrap();
        let assertion = validate_saml_response(root.path(), "acme", "<saml-response>").unwrap();
        assert_eq!(assertion.tenant, "acme");
        assert_eq!(assertion.provider, SSOProvider::Okta);
        assert!(!assertion.email.is_empty());
        assert!(!assertion.roles.is_empty());
    }

    #[test]
    fn validate_saml_rejects_empty_response() {
        let root = TempDir::new();
        write_config(root.path(), &sample_config("acme")).unwrap();
        let err = validate_saml_response(root.path(), "acme", "").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_empty_response"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn validate_saml_rejects_unknown_tenant() {
        let root = TempDir::new();
        let err = validate_saml_response(root.path(), "nope", "anything").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_unknown_tenant"),
            other => panic!("expected User error, got {:?}", other),
        }
    }
}
