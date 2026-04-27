//! v3.5 §5.1 — SSO SAML scaffold (Wave 2: real-mode validate path).
//!
//! Two providers prioritized for v3.5: Okta + Azure AD (~80% of F500 per
//! `V3_5_SPEC.md` §5.1). Google Workspace SSO deferred to v3.6.
//!
//! ## Wave 2 changes
//!
//! Adds `validate_saml_response_with_cert(response, sp_cert)` which performs
//! structural SAML 2.0 validation when an SP cert is configured on the tenant:
//!
//!   * base64-decode the response (Okta + Azure AD post the assertion as
//!     base64-encoded XML)
//!   * basic XML structure check — must contain `<samlp:Response>`,
//!     `<saml:Assertion>`, `<saml:Issuer>`, `<saml:Subject>`, and
//!     `<ds:Signature>` per SAML 2.0 §3.4
//!   * Issuer matches the configured tenant's expected IdP entity id
//!   * NotBefore / NotOnOrAfter window check against `Utc::now()`
//!
//! What this does NOT do (deliberately, to avoid pulling `samael` /
//! `xmlsec` / `libxml2` / `openssl-sys` into the dep tree):
//!   * Signature cryptographic verification (XMLDSig over the assertion).
//!     We check that `<ds:SignatureValue>` is present and non-empty, but we
//!     do not validate the digest. **TODO production: integrate `samael`
//!     or `saml-rs` for full signature + canonicalization verification once
//!     the AGPL crate dep budget allows it.** The `sp_cert` argument is
//!     accepted on the surface so the IPC contract is locked; in stub mode
//!     it's used only as a presence flag (real-mode-on switch).
//!   * Encrypted assertion decryption — Okta / Azure AD encrypted assertions
//!     are deferred until samael lands. Mainline F500 customers default to
//!     signed-only assertions for v3.5.
//!
//! Stub mode (`sp_cert` empty or absent) **remains the default** so the
//! React provisioning UI keeps working without an IdP wired up.
//!
//! Spec note: Google Workspace SSO is explicitly NOT in v3.5 — v3.6 deferred.

use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
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
    /// Optional SP X.509 cert (PEM string) — when present, `validate_saml_response`
    /// flips into real-mode structural checks. When `None` or empty, stub mode
    /// returns the deterministic mock assertion. Set by the admin console
    /// during the IdP setup flow.
    #[serde(default)]
    pub sp_cert: Option<String>,
    /// Optional expected IdP entity id — the value the SAML response's
    /// `<saml:Issuer>` element MUST match. When absent, real-mode skips
    /// the issuer check (acceptable for early IdP setup).
    #[serde(default)]
    pub expected_issuer: Option<String>,
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
    /// Whether the assertion came from a real-mode validation (true) or the
    /// stub path (false). React-side JIT-provision UI surfaces this so admin
    /// can see which mode fired during IdP setup.
    #[serde(default)]
    pub validated: bool,
}

/// Distinguishes a real-mode validation failure (signature missing,
/// NotOnOrAfter expired, issuer mismatch) from a stub-mode pass-through.
/// React surfaces use this to render different UX — `Stub` lets the admin
/// proceed with JIT provision, `Real` posts a hard error.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssertionResult {
    /// Stub mode (no SP cert configured). Returns the deterministic mock.
    Stub { assertion: SAMLAssertion },
    /// Real-mode pass — structural checks all green.
    Real { assertion: SAMLAssertion },
}

impl AssertionResult {
    pub fn into_assertion(self) -> SAMLAssertion {
        match self {
            AssertionResult::Stub { assertion } | AssertionResult::Real { assertion } => assertion,
        }
    }
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Stub validator (kept for backward-compatible Tauri command).
///
/// v3.5 wave 2: when the tenant's `SSOConfig.sp_cert` is set, dispatch to
/// the real-mode structural validator. Otherwise return the deterministic
/// mock so the React JIT-provisioning UI keeps working in dev.
pub fn validate_saml_response(
    memory_root: &Path,
    tenant: &str,
    response: &str,
) -> Result<SAMLAssertion, AppError> {
    let result = validate_saml_response_with_result(memory_root, tenant, response)?;
    Ok(result.into_assertion())
}

/// Validate a SAML response and return the result variant — either `Stub`
/// (deterministic mock) or `Real` (structural checks passed).
pub fn validate_saml_response_with_result(
    memory_root: &Path,
    tenant: &str,
    response: &str,
) -> Result<AssertionResult, AppError> {
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

    // Real mode lights up only when an SP cert is configured. Otherwise
    // the IdP setup is incomplete — fall back to stub so the React UI can
    // still demo JIT provisioning.
    let real_mode = cfg
        .sp_cert
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if !real_mode {
        return Ok(AssertionResult::Stub {
            assertion: stub_assertion(&cfg, tenant),
        });
    }

    // Real-mode structural validation.
    let xml = decode_response(response)?;
    structural_check(&xml)?;
    if let Some(expected) = cfg.expected_issuer.as_deref() {
        let issuer = extract_issuer(&xml).ok_or_else(|| {
            AppError::user(
                "sso_missing_issuer",
                "SAML response has no <saml:Issuer> element",
            )
        })?;
        if issuer != expected {
            return Err(AppError::user(
                "sso_issuer_mismatch",
                format!(
                    "issuer '{}' does not match expected '{}'",
                    issuer, expected
                ),
            ));
        }
    }
    if let Some((not_before, not_on_or_after)) = extract_validity_window(&xml) {
        let now = Utc::now();
        if let Some(nb) = not_before {
            if now < nb {
                return Err(AppError::user(
                    "sso_assertion_not_yet_valid",
                    format!("NotBefore={} > now={}", nb, now),
                ));
            }
        }
        if let Some(nooa) = not_on_or_after {
            if now >= nooa {
                return Err(AppError::user(
                    "sso_assertion_expired",
                    format!("NotOnOrAfter={} <= now={}", nooa, now),
                ));
            }
        }
    }
    let email = extract_subject_name_id(&xml).unwrap_or_else(|| {
        format!("user@{}.tangerine-cloud.com", tenant)
    });
    let display_name = extract_attribute(&xml, "displayname")
        .or_else(|| extract_attribute(&xml, "name"))
        .unwrap_or_else(|| format!("Real User ({})", tenant));
    let roles = extract_roles(&xml)
        .unwrap_or_else(|| vec!["member".to_string()]);
    Ok(AssertionResult::Real {
        assertion: SAMLAssertion {
            email,
            display_name,
            tenant: tenant.to_string(),
            provider: cfg.provider,
            roles,
            validated: true,
        },
    })
}

fn stub_assertion(cfg: &SSOConfig, tenant: &str) -> SAMLAssertion {
    SAMLAssertion {
        email: format!("user@{}.tangerine-cloud.com", tenant),
        display_name: format!("Test User ({})", tenant),
        tenant: tenant.to_string(),
        provider: cfg.provider.clone(),
        roles: vec!["member".to_string()],
        validated: false,
    }
}

// ---------------------------------------------------------------------------
// Real-mode structural helpers (substring-based — no XML parser)
// ---------------------------------------------------------------------------
//
// Keeping the dep budget tight: a full XML parser (`quick-xml`, `xml-rs`)
// would be the right call for production, but the structural checks below
// are enough to lock the IPC contract and ship the SP cert plumbing.
// `samael` integration (full XMLDSig + canonicalization) is the production
// follow-up.

/// Decode the SAML response. IdPs post the response as either:
///   * raw XML (rare — only Test IdPs)
///   * base64-encoded XML (Okta / Azure AD default)
///
/// We try base64 first; if that fails, treat the input as raw XML.
fn decode_response(response: &str) -> Result<String, AppError> {
    let trimmed = response.trim();
    // Already starts with `<` — assume raw XML.
    if trimmed.starts_with('<') {
        return Ok(trimmed.to_string());
    }
    let bytes = STANDARD.decode(trimmed.as_bytes()).map_err(|e| {
        AppError::user(
            "sso_bad_base64",
            format!("SAML response is not valid base64: {}", e),
        )
    })?;
    String::from_utf8(bytes).map_err(|e| {
        AppError::user(
            "sso_bad_utf8",
            format!("decoded SAML response is not valid UTF-8: {}", e),
        )
    })
}

/// Reject responses that are missing required SAML 2.0 elements per §3.4.
fn structural_check(xml: &str) -> Result<(), AppError> {
    let required = [
        ("samlp:Response", "<samlp:Response>"),
        ("saml:Assertion", "<saml:Assertion>"),
        ("saml:Issuer", "<saml:Issuer>"),
        ("saml:Subject", "<saml:Subject>"),
        ("ds:Signature", "<ds:Signature>"),
    ];
    for (needle, label) in required {
        if !xml.contains(needle) {
            return Err(AppError::user(
                "sso_missing_element",
                format!("required SAML element '{}' missing from response", label),
            ));
        }
    }
    if !xml.contains("ds:SignatureValue") {
        return Err(AppError::user(
            "sso_missing_signature_value",
            "SAML signature value missing",
        ));
    }
    Ok(())
}

/// Extract the value between the first `<saml:Issuer>...</saml:Issuer>` pair.
fn extract_issuer(xml: &str) -> Option<String> {
    extract_between(xml, "<saml:Issuer>", "</saml:Issuer>")
        .or_else(|| extract_between(xml, "<Issuer>", "</Issuer>"))
}

fn extract_subject_name_id(xml: &str) -> Option<String> {
    extract_between(xml, "<saml:NameID", "</saml:NameID>").map(strip_attrs_prefix)
        .or_else(|| extract_between(xml, "<NameID", "</NameID>").map(strip_attrs_prefix))
}

fn extract_attribute(xml: &str, name_lower: &str) -> Option<String> {
    let lower = xml.to_lowercase();
    let needle = format!(r#"name="{}""#, name_lower);
    let pos = lower.find(&needle)?;
    // Find the AttributeValue after this Attribute open tag.
    let after = &xml[pos..];
    let val_start = after.find("<saml:AttributeValue")
        .or_else(|| after.find("<AttributeValue"))?;
    let val_open_end = after[val_start..].find('>')? + val_start + 1;
    let val_close_lower = after[val_open_end..].to_lowercase();
    let val_close_offset = val_close_lower
        .find("</saml:attributevalue>")
        .or_else(|| val_close_lower.find("</attributevalue>"))?;
    Some(after[val_open_end..val_open_end + val_close_offset].trim().to_string())
}

fn extract_roles(xml: &str) -> Option<Vec<String>> {
    let lower = xml.to_lowercase();
    let needle = r#"name="role""#;
    let pos = lower.find(needle)?;
    // Walk every AttributeValue under this Role attribute.
    let mut out = Vec::new();
    let mut cursor = pos;
    while let Some(rel) = xml[cursor..].find("AttributeValue") {
        let abs = cursor + rel;
        let open_end = xml[abs..].find('>').map(|o| abs + o + 1)?;
        let close_lower = xml[open_end..].to_lowercase();
        let close_rel = close_lower.find("</saml:attributevalue>")
            .or_else(|| close_lower.find("</attributevalue>"))?;
        let val = xml[open_end..open_end + close_rel].trim().to_string();
        if !val.is_empty() {
            out.push(val);
        }
        cursor = open_end + close_rel;
        // Stop if we leave the current Attribute.
        if let Some(next_attr) = xml[cursor..].find("<saml:Attribute ") {
            if next_attr < xml[cursor..].find("AttributeValue").unwrap_or(usize::MAX) {
                break;
            }
        } else {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_validity_window(xml: &str) -> Option<(Option<DateTime<Utc>>, Option<DateTime<Utc>>)> {
    let not_before = extract_attr_value(xml, "NotBefore")
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&Utc));
    let not_on_or_after = extract_attr_value(xml, "NotOnOrAfter")
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&Utc));
    if not_before.is_none() && not_on_or_after.is_none() {
        return None;
    }
    Some((not_before, not_on_or_after))
}

/// Pull the value of `attr="..."` (first occurrence) out of an XML string.
fn extract_attr_value(xml: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=\"", attr);
    let pos = xml.find(&needle)?;
    let start = pos + needle.len();
    let end_rel = xml[start..].find('"')?;
    Some(xml[start..start + end_rel].to_string())
}

/// Pull text between `start` and `end` markers. `start` may already include
/// the closing `>` (e.g. `<saml:Issuer>`); when it does the inner text
/// begins right after the marker. When it doesn't (e.g. `<saml:NameID`), we
/// scan forward to the next `>` to skip element attributes.
fn extract_between(xml: &str, start: &str, end: &str) -> Option<String> {
    let s = xml.find(start)? + start.len();
    let inner_start = if start.ends_with('>') {
        s
    } else {
        s + xml[s..].find('>')? + 1
    };
    let close = xml[inner_start..].find(end)?;
    Some(xml[inner_start..inner_start + close].trim().to_string())
}

/// Strip any leading `<...>` opening tag remnant before NameID inner text.
/// `extract_between("<saml:NameID Format=...>val", ...)` returns
/// `Format=..." />val`-shaped junk; this helper trims it back.
fn strip_attrs_prefix(s: String) -> String {
    if let Some(idx) = s.rfind('>') {
        s[idx + 1..].trim().to_string()
    } else {
        s.trim().to_string()
    }
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
            sp_cert: None,
            expected_issuer: None,
        }
    }

    fn sample_real_config(tenant: &str, expected_issuer: &str) -> SSOConfig {
        SSOConfig {
            provider: SSOProvider::Okta,
            metadata_url: format!("https://acme.okta.com/app/{}/sso/saml/metadata", tenant),
            sp_entity_id: format!("urn:tangerine:{}", tenant),
            tenant: tenant.to_string(),
            sp_cert: Some(
                "-----BEGIN CERTIFICATE-----\nFAKEFAKEFAKEFAKE\n-----END CERTIFICATE-----"
                    .into(),
            ),
            expected_issuer: Some(expected_issuer.into()),
        }
    }

    fn well_formed_saml(issuer: &str) -> String {
        format!(
            r#"<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Issuer>{issuer}</saml:Issuer>
  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:SignedInfo />
    <ds:SignatureValue>FAKE_SIGNATURE_VALUE</ds:SignatureValue>
  </ds:Signature>
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@acme.com</saml:NameID>
    </saml:Subject>
    <saml:Conditions NotBefore="2020-01-01T00:00:00Z" NotOnOrAfter="2099-01-01T00:00:00Z" />
    <saml:AttributeStatement>
      <saml:Attribute Name="displayName"><saml:AttributeValue>Alice Acme</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="role"><saml:AttributeValue>admin</saml:AttributeValue><saml:AttributeValue>member</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>"#,
            issuer = issuer,
        )
    }

    fn b64(s: &str) -> String {
        STANDARD.encode(s.as_bytes())
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
    fn validate_saml_returns_mock_assertion_in_stub_mode() {
        let root = TempDir::new();
        write_config(root.path(), &sample_config("acme")).unwrap();
        let assertion = validate_saml_response(root.path(), "acme", "<saml-response>").unwrap();
        assert_eq!(assertion.tenant, "acme");
        assert_eq!(assertion.provider, SSOProvider::Okta);
        assert!(!assertion.email.is_empty());
        assert!(!assertion.roles.is_empty());
        assert!(!assertion.validated, "stub-mode assertion should not be marked validated");
    }

    #[test]
    fn validate_saml_with_result_returns_stub_variant() {
        let root = TempDir::new();
        write_config(root.path(), &sample_config("acme")).unwrap();
        let result = validate_saml_response_with_result(root.path(), "acme", "<saml-response>").unwrap();
        match result {
            AssertionResult::Stub { assertion } => {
                assert_eq!(assertion.tenant, "acme");
                assert!(!assertion.validated);
            }
            AssertionResult::Real { .. } => panic!("expected stub variant"),
        }
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

    // -------------------------------------------------------------------
    // Real-mode validation
    // -------------------------------------------------------------------

    #[test]
    fn real_mode_passes_well_formed_response() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        let xml = well_formed_saml("https://acme.okta.com");
        let result = validate_saml_response_with_result(root.path(), "acme", &b64(&xml)).unwrap();
        match result {
            AssertionResult::Real { assertion } => {
                assert!(assertion.validated);
                assert_eq!(assertion.email, "alice@acme.com");
                assert_eq!(assertion.display_name, "Alice Acme");
                assert!(assertion.roles.iter().any(|r| r == "admin"));
            }
            AssertionResult::Stub { .. } => panic!("expected real variant"),
        }
    }

    #[test]
    fn real_mode_accepts_raw_xml_without_base64() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        let xml = well_formed_saml("https://acme.okta.com");
        let result = validate_saml_response_with_result(root.path(), "acme", &xml).unwrap();
        match result {
            AssertionResult::Real { assertion } => assert!(assertion.validated),
            AssertionResult::Stub { .. } => panic!("expected real variant"),
        }
    }

    #[test]
    fn real_mode_rejects_missing_signature() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        // Same as well_formed_saml but with the <ds:Signature> block stripped.
        let xml = r#"<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Issuer>https://acme.okta.com</saml:Issuer>
  <saml:Assertion>
    <saml:Subject><saml:NameID>alice@acme.com</saml:NameID></saml:Subject>
  </saml:Assertion>
</samlp:Response>"#;
        let err = validate_saml_response(root.path(), "acme", &b64(xml)).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_missing_element"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn real_mode_rejects_issuer_mismatch() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        let xml = well_formed_saml("https://forged.example.com");
        let err = validate_saml_response(root.path(), "acme", &b64(&xml)).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_issuer_mismatch"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn real_mode_rejects_expired_assertion() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        let mut xml = well_formed_saml("https://acme.okta.com");
        xml = xml.replace(
            r#"NotOnOrAfter="2099-01-01T00:00:00Z""#,
            r#"NotOnOrAfter="2000-01-01T00:00:00Z""#,
        );
        let err = validate_saml_response(root.path(), "acme", &b64(&xml)).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_assertion_expired"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn real_mode_rejects_bad_base64() {
        let root = TempDir::new();
        write_config(root.path(), &sample_real_config("acme", "https://acme.okta.com")).unwrap();
        let err = validate_saml_response(root.path(), "acme", "!!!not-base64!!!").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "sso_bad_base64"),
            other => panic!("expected User error, got {:?}", other),
        }
    }

    #[test]
    fn extract_issuer_finds_value() {
        let xml = well_formed_saml("https://acme.okta.com");
        assert_eq!(extract_issuer(&xml).unwrap(), "https://acme.okta.com");
    }

    #[test]
    fn extract_validity_window_parses_both_bounds() {
        let xml = well_formed_saml("https://acme.okta.com");
        let (nb, nooa) = extract_validity_window(&xml).unwrap();
        assert!(nb.is_some());
        assert!(nooa.is_some());
    }
}
