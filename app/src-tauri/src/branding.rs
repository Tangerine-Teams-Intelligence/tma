//! v3.5 §4 — Enterprise white-label branding.
//!
//! Reads / writes the per-tenant branding override under
//! `~/.tangerine-memory/.tangerine/branding.json`. Default config is the
//! Tangerine baseline (orange `#CC5500`, deep navy `#1A1A2E`,
//! product name "Tangerine"). Enterprise tenants overlay their own logo,
//! palette, custom subdomain, product name, and email sender.
//!
//! Stub mode default: this module ships a license validator that always
//! returns `true` for `tangerine-trial-*` keys; the production cut runs the
//! real entitlement check against the licensing service. See `validate_license`.
//!
//! v3.5 §4.1 lists what we DO NOT white-label: the AGPL footer, the
//! "powered by Tangerine" attribution in the help dialog, the OSS
//! repository link. Buyers wanting to remove them get the on-premise
//! package.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::AppError;

/// Brand identity overlay applied to the React app shell. Frontend reads
/// these via `app/src/lib/branding.ts` and injects them as CSS variables.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrandingConfig {
    /// URL or absolute path to the buyer's logo. Empty string ⇒ use the
    /// bundled Tangerine logo.
    pub logo_url: String,
    /// CSS hex (e.g. `#CC5500`). Maps to `--ti-brand-primary`.
    pub primary_color: String,
    /// CSS hex. Maps to `--ti-brand-accent`.
    pub accent_color: String,
    /// Custom domain, e.g. `tangerine.acme.com`. Empty string ⇒ default
    /// `${tenant}.tangerine-cloud.com` subdomain.
    pub custom_domain: String,
    /// Product display name, replaces the visible "Tangerine" string.
    /// Empty string ⇒ keep "Tangerine".
    pub app_name: String,
}

impl BrandingConfig {
    /// Tangerine default — what an OSS user / unbranded tenant sees.
    pub fn tangerine_default() -> Self {
        Self {
            logo_url: String::new(),
            primary_color: "#CC5500".to_string(),
            accent_color: "#1A1A2E".to_string(),
            custom_domain: String::new(),
            app_name: "Tangerine".to_string(),
        }
    }

    /// True iff every field matches the Tangerine baseline. The frontend
    /// uses this to decide whether to render the "Powered by Tangerine"
    /// help-dialog attribution (always shown for default; AGPL footer is
    /// shown regardless per spec §4.1).
    pub fn is_default(&self) -> bool {
        self == &Self::tangerine_default()
    }
}

impl Default for BrandingConfig {
    fn default() -> Self {
        Self::tangerine_default()
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn branding_dir(memory_root: &Path) -> Result<PathBuf, AppError> {
    let dir = memory_root.join(".tangerine");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal("branding_mkdir", e.to_string()))?;
    Ok(dir)
}

fn branding_path(memory_root: &Path) -> Result<PathBuf, AppError> {
    Ok(branding_dir(memory_root)?.join("branding.json"))
}

/// Read the persisted branding override. Returns the Tangerine default when
/// the file is missing or unreadable — branding is non-essential to app
/// startup, so a corrupt file logs and falls back rather than blocking the
/// boot path.
pub fn read_branding(memory_root: &Path) -> Result<BrandingConfig, AppError> {
    let path = branding_path(memory_root)?;
    if !path.exists() {
        return Ok(BrandingConfig::tangerine_default());
    }
    let raw = match fs::read_to_string(&path) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "failed to read branding.json — falling back to default"
            );
            return Ok(BrandingConfig::tangerine_default());
        }
    };
    if raw.trim().is_empty() {
        return Ok(BrandingConfig::tangerine_default());
    }
    Ok(serde_json::from_str(&raw)?)
}

/// Persist a new override. Writing the Tangerine default explicitly is
/// allowed and behaves the same as `reset_to_default` for the consumer
/// (read returns the default either way).
pub fn write_branding(memory_root: &Path, cfg: &BrandingConfig) -> Result<(), AppError> {
    let path = branding_path(memory_root)?;
    let raw = serde_json::to_string_pretty(cfg)?;
    fs::write(&path, raw)
        .map_err(|e| AppError::internal("branding_write", e.to_string()))?;
    Ok(())
}

/// Apply a branding override. Validates the hex colors before writing so a
/// malformed config can never poison the React-side CSS injection.
pub fn apply_branding(memory_root: &Path, cfg: BrandingConfig) -> Result<BrandingConfig, AppError> {
    if !is_valid_hex(&cfg.primary_color) {
        return Err(AppError::user(
            "branding_bad_primary",
            format!("primary_color '{}' is not a hex color", cfg.primary_color),
        ));
    }
    if !is_valid_hex(&cfg.accent_color) {
        return Err(AppError::user(
            "branding_bad_accent",
            format!("accent_color '{}' is not a hex color", cfg.accent_color),
        ));
    }
    write_branding(memory_root, &cfg)?;
    Ok(cfg)
}

/// Drop the override and return to the Tangerine baseline. Removes the
/// `branding.json` file so the next `read_branding` call returns the
/// default freshly.
pub fn reset_to_default(memory_root: &Path) -> Result<BrandingConfig, AppError> {
    let path = branding_path(memory_root)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| AppError::internal("branding_reset_rm", e.to_string()))?;
    }
    Ok(BrandingConfig::tangerine_default())
}

// ---------------------------------------------------------------------------
// License gate (stub)
// ---------------------------------------------------------------------------

/// Stub license validator. Production v3.5 calls the licensing service
/// (Stripe + signed JWT) to confirm the entitlement; until then, we accept
/// any non-empty key starting with `tangerine-trial-` or
/// `tangerine-license-` as valid. The buyer's tenant id (when present) is
/// echoed back so the React UI can show "Licensed to: <tenant>".
pub fn validate_license(key: &str) -> Result<LicenseValidation, AppError> {
    if key.is_empty() {
        return Ok(LicenseValidation {
            valid: false,
            tenant: None,
            tier: None,
        });
    }
    if let Some(rest) = key.strip_prefix("tangerine-trial-") {
        return Ok(LicenseValidation {
            valid: true,
            tenant: Some(rest.to_string()),
            tier: Some("trial".to_string()),
        });
    }
    if let Some(rest) = key.strip_prefix("tangerine-license-") {
        // `tangerine-license-<tier>-<tenant>` is the convention.
        let mut parts = rest.splitn(2, '-');
        let tier = parts.next().unwrap_or("starter").to_string();
        let tenant = parts.next().unwrap_or("unknown").to_string();
        return Ok(LicenseValidation {
            valid: true,
            tenant: Some(tenant),
            tier: Some(tier),
        });
    }
    Ok(LicenseValidation {
        valid: false,
        tenant: None,
        tier: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LicenseValidation {
    pub valid: bool,
    pub tenant: Option<String>,
    /// One of `"trial"`, `"starter"`, `"professional"`, `"enterprise"`.
    /// Mirrors `V3_5_SPEC.md` §4.5 pricing band.
    pub tier: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_valid_hex(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return false;
    }
    bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
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
            let p = std::env::temp_dir().join(format!("ti-branding-{}", id));
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

    #[test]
    fn default_config_matches_tangerine_baseline() {
        let cfg = BrandingConfig::tangerine_default();
        assert_eq!(cfg.app_name, "Tangerine");
        assert_eq!(cfg.primary_color, "#CC5500");
        assert_eq!(cfg.accent_color, "#1A1A2E");
        assert!(cfg.is_default());
    }

    #[test]
    fn read_returns_default_when_missing() {
        let root = TempDir::new();
        let cfg = read_branding(root.path()).unwrap();
        assert!(cfg.is_default());
    }

    #[test]
    fn apply_persists_override_and_read_returns_it() {
        let root = TempDir::new();
        let custom = BrandingConfig {
            logo_url: "https://acme.com/logo.svg".into(),
            primary_color: "#0066FF".into(),
            accent_color: "#FF6600".into(),
            custom_domain: "tangerine.acme.com".into(),
            app_name: "Acme-AGI".into(),
        };
        let applied = apply_branding(root.path(), custom.clone()).unwrap();
        assert_eq!(applied, custom);
        let read = read_branding(root.path()).unwrap();
        assert_eq!(read, custom);
        assert!(!read.is_default());
    }

    #[test]
    fn reset_drops_override() {
        let root = TempDir::new();
        let custom = BrandingConfig {
            primary_color: "#0066FF".into(),
            ..BrandingConfig::tangerine_default()
        };
        apply_branding(root.path(), custom).unwrap();
        let reset = reset_to_default(root.path()).unwrap();
        assert!(reset.is_default());
        let read = read_branding(root.path()).unwrap();
        assert!(read.is_default());
    }

    #[test]
    fn apply_rejects_bad_primary_color() {
        let root = TempDir::new();
        let bad = BrandingConfig {
            primary_color: "not-a-hex".into(),
            ..BrandingConfig::tangerine_default()
        };
        let err = apply_branding(root.path(), bad).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "branding_bad_primary"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn apply_rejects_bad_accent_color() {
        let root = TempDir::new();
        let bad = BrandingConfig {
            accent_color: "#XYZ".into(),
            ..BrandingConfig::tangerine_default()
        };
        let err = apply_branding(root.path(), bad).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "branding_bad_accent"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn validate_license_rejects_empty() {
        let v = validate_license("").unwrap();
        assert!(!v.valid);
    }

    #[test]
    fn validate_license_accepts_trial_prefix() {
        let v = validate_license("tangerine-trial-acme").unwrap();
        assert!(v.valid);
        assert_eq!(v.tenant.as_deref(), Some("acme"));
        assert_eq!(v.tier.as_deref(), Some("trial"));
    }

    #[test]
    fn validate_license_accepts_license_prefix() {
        let v = validate_license("tangerine-license-enterprise-megacorp").unwrap();
        assert!(v.valid);
        assert_eq!(v.tier.as_deref(), Some("enterprise"));
        assert_eq!(v.tenant.as_deref(), Some("megacorp"));
    }

    #[test]
    fn validate_license_rejects_unknown_prefix() {
        let v = validate_license("foobar").unwrap();
        assert!(!v.valid);
    }

    #[test]
    fn hex_validator_rejects_short_and_long_strings() {
        assert!(is_valid_hex("#CC5500"));
        assert!(!is_valid_hex("#CC55"));
        assert!(!is_valid_hex("#CC550000"));
        assert!(!is_valid_hex("CC5500"));
        assert!(!is_valid_hex("#GG5500"));
    }
}
