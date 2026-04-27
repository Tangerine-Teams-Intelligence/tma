//! v3.5 §5.1 — Tauri command surface for SSO SAML.
//!
//! v3.5 wave 2: real-mode structural validation lights up when the tenant's
//! `SSOConfig.sp_cert` is configured. Stub mode (no cert) returns the
//! deterministic mock so the React JIT-provisioning UI keeps working in dev.
//!
//! Production cut wires `keycloak-rs` / WorkOS / `samael` for full XMLDSig
//! signature verification + canonicalization via a single-file swap inside
//! the lib.

use std::path::PathBuf;

use crate::sso::{self, AssertionResult, SAMLAssertion, SSOConfig};

use super::AppError;

fn resolve_memory_root() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::internal("home_dir", "home_dir() returned None"))?;
    Ok(home.join(".tangerine-memory"))
}

/// Persist an SSO SAML config for a tenant.
#[tauri::command]
pub async fn sso_set_config(config: SSOConfig) -> Result<SSOConfig, AppError> {
    let root = resolve_memory_root()?;
    sso::write_config(&root, &config)?;
    Ok(config)
}

/// Read the SSO config for a given tenant. Returns `None` when the tenant
/// has no SAML configured yet.
#[tauri::command]
pub async fn sso_get_config(tenant: String) -> Result<Option<SSOConfig>, AppError> {
    let root = resolve_memory_root()?;
    sso::read_config(&root, &tenant)
}

/// List every persisted SSO config — used by the admin console to surface
/// every tenant with SSO enabled.
#[tauri::command]
pub async fn sso_list_configs() -> Result<Vec<SSOConfig>, AppError> {
    let root = resolve_memory_root()?;
    sso::list_configs(&root)
}

/// Validate a SAML response. Wave 2: returns the unwrapped `SAMLAssertion`
/// for backward compat. New callers should prefer
/// `sso_validate_saml_response_with_result` which surfaces stub vs real
/// mode for UX disambiguation.
#[tauri::command]
pub async fn sso_validate_saml_response(
    tenant: String,
    response: String,
) -> Result<SAMLAssertion, AppError> {
    let root = resolve_memory_root()?;
    sso::validate_saml_response(&root, &tenant, &response)
}

/// Validate a SAML response and return the result variant
/// (`AssertionResult::Stub` or `AssertionResult::Real`). React-side
/// admin UI uses the variant to render different UX — `Stub` lets the
/// admin proceed with JIT provision, `Real` posts a hard error on failure.
#[tauri::command]
pub async fn sso_validate_saml_response_with_result(
    tenant: String,
    response: String,
) -> Result<AssertionResult, AppError> {
    let root = resolve_memory_root()?;
    sso::validate_saml_response_with_result(&root, &tenant, &response)
}
